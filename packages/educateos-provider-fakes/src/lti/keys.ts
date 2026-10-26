// A platform's id_token signing keys: RS256 pairs generated with Web Crypto, the JWKS that
// publishes them (RFC 7517; LTI Security Framework 1.0 §6.3 requires `kid` in every JWT header so a
// tool can pick the key), and the rotation, withdrawal and forging tests need. Promoted from the
// `FakePlatform` of `@educateos/lti`'s tests, keeping its behaviour. A `kid` carries a random part:
// a counter alone would repeat after a Worker restart, and a tool holding a cached JWKS would then
// verify a new key's signatures against the old key.
import { SignJWT, type JWK } from "jose";

/** A platform signing key: its `kid`, the private key, and the public half as a JWK. */
export interface PlatformKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

let kidCounter = 0;

/** Generates an RS256 key pair with a fresh `kid`. A `modulusLength` under 2048 makes a weak key. */
export async function generatePlatformKey(modulusLength = 2048): Promise<PlatformKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JWK;
  kidCounter += 1;
  return { kid: `platform-key-${kidCounter}-${crypto.randomUUID().slice(0, 8)}`, privateKey: pair.privateKey, publicJwk };
}

/** Options for {@link PlatformKeyRing.sign}. */
export interface SignOptions {
  /** The key to sign with. Defaults to the current signing key; pass an unpublished key to forge. */
  readonly key?: PlatformKey;
  /** The `kid` header to send. Defaults to the key's own; pass another to lie about it. */
  readonly kid?: string;
}

/**
 * The keys a platform signs with and publishes. A rotation can keep the old key published (the
 * usual overlap) or withdraw it (as after a compromise).
 */
export class PlatformKeyRing {
  /** The key it signs with. */
  signingKey: PlatformKey;
  /** The keys its JWKS publishes, newest first. */
  published: PlatformKey[];

  constructor(key: PlatformKey) {
    this.signingKey = key;
    this.published = [key];
  }

  /** A ring with one freshly generated key. */
  static async create(): Promise<PlatformKeyRing> {
    return new PlatformKeyRing(await generatePlatformKey());
  }

  /** The JWKS document the platform serves. */
  jwks(): { keys: JWK[] } {
    return { keys: this.published.map((key) => ({ ...key.publicJwk, kid: key.kid, alg: "RS256", use: "sig" })) };
  }

  /** Rotates to a new signing key. With `withdrawOld`, only the new key stays published. */
  async rotate(withdrawOld: boolean): Promise<PlatformKey> {
    const next = await generatePlatformKey();
    this.published = withdrawOld ? [next] : [next, ...this.published];
    this.signingKey = next;
    return next;
  }

  /** Stops publishing the key `kid`. Tokens it signed no longer verify once a tool refetches. */
  withdraw(kid: string): void {
    this.published = this.published.filter((key) => key.kid !== kid);
  }

  /** Signs `claims` as an RS256 JWT with `typ: JWT` and a `kid` header. */
  async sign(claims: Record<string, unknown>, options: SignOptions = {}): Promise<string> {
    const key = options.key ?? this.signingKey;
    return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: options.kid ?? key.kid, typ: "JWT" }).sign(key.privateKey);
  }
}
