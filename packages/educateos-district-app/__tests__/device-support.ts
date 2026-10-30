// A stand-in phone for the device API tests (SCHO-261): a P-256 key pair, and the access and
// refresh tokens the district issued it, signing a fresh ES256 proof for every request exactly as
// docs/educateos/mobile.md tells the native client to.
import type { DeviceRegistration, DeviceTokens } from "../src/index.ts";

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** What a proof is made over; each field may be overridden to make a bad one. */
export interface ProofParts {
  htm: string;
  htu: string;
  /** Seconds since the epoch. */
  iat: number;
  ath: string;
  jti: string;
}

export class TestPhone {
  readonly keys: CryptoKeyPair;
  readonly publicJwk: JsonWebKey;
  tokens: DeviceTokens | undefined;
  /** The clock proofs are dated by. */
  readonly now: () => number;

  private constructor(keys: CryptoKeyPair, publicJwk: JsonWebKey, now: () => number) {
    this.keys = keys;
    this.publicJwk = publicJwk;
    this.now = now;
  }

  static async create(now: () => number = Date.now): Promise<TestPhone> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", keys.publicKey);
    return new TestPhone(keys, { kty, crv, x, y }, now);
  }

  registration(label = "Ava's iPhone"): DeviceRegistration {
    return { publicJwk: this.publicJwk, label, platform: "ios", model: "iPhone 16", appVersion: "1.4.0" };
  }

  /** A compact ES256 JWS over `parts`, signed with `key` (this phone's own by default). */
  async sign(parts: ProofParts, key: CryptoKey = this.keys.privateKey, header: Record<string, unknown> = { alg: "ES256", typ: "device-proof+jwt" }): Promise<string> {
    const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(parts)))}`;
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input)));
    return `${input}.${base64url(signature)}`;
  }

  /** A proof for one request: `token` is the access token, or the refresh token for a refresh. */
  async proof(method: string, path: string, token: string, overrides: Partial<ProofParts> = {}, key?: CryptoKey): Promise<string> {
    return this.sign({
      htm: method,
      htu: path,
      iat: Math.floor(this.now() / 1000),
      ath: await sha256(token),
      jti: crypto.randomUUID(),
      ...overrides,
    }, key);
  }

  /** A device API request with this phone's access token and a fresh proof. */
  async request(method: string, path: string, options: { body?: unknown; proof?: Partial<ProofParts>; key?: CryptoKey; accessToken?: string } = {}): Promise<Request> {
    const accessToken = options.accessToken ?? this.tokens!.accessToken;
    const headers: Record<string, string> = {
      authorization: `Device ${accessToken}`,
      "device-proof": await this.proof(method, path, accessToken, options.proof, options.key),
    };
    if (method === "POST") headers["content-type"] = "application/json";
    return new Request(`https://district.example${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(options.body ?? {}) } : {}),
    });
  }

  /** A refresh request for `refreshToken` (this phone's current one by default). */
  async refreshRequest(options: { refreshToken?: string; proof?: Partial<ProofParts>; key?: CryptoKey; noProof?: boolean } = {}): Promise<Request> {
    const refreshToken = options.refreshToken ?? this.tokens!.refreshToken;
    const path = "/api/m/token/refresh";
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.noProof !== true) headers["device-proof"] = await this.proof("POST", path, refreshToken, options.proof, options.key);
    return new Request(`https://district.example${path}`, { method: "POST", headers, body: JSON.stringify({ refreshToken }) });
  }
}

/** A response's status and JSON body, read whole. */
export async function read(response: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
