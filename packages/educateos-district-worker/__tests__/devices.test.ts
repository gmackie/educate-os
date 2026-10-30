// Device identity in workerd (SCHO-261): the device API through the Worker's own fetch handler,
// over the district's real SQLite Durable Object. Devices, spent refresh tokens and seen proof IDs
// survive a restart of the object, and every route under /api/m refuses a request with no device
// credential (the full refusal matrix runs in @educateos/district-app's devices.test.ts).

import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES, pathParameterNames, routePath, type RouteSpec } from "@educateos/district-app/routes";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const AMARA = "prn_nf-student-amara";
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const sha256 = async (text: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

interface Tokens {
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}

/** A phone: a P-256 key, its tokens, and a fresh ES256 proof per request. */
class Phone {
  keys!: CryptoKeyPair;
  publicJwk!: JsonWebKey;
  tokens!: Tokens;

  static async create(): Promise<Phone> {
    const phone = new Phone();
    phone.keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", phone.keys.publicKey) as JsonWebKey;
    phone.publicJwk = { kty, crv, x, y };
    return phone;
  }

  async proof(method: string, path: string, token: string): Promise<string> {
    const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", typ: "device-proof+jwt" })));
    const claims = { htm: method, htu: path, iat: Math.floor(Date.now() / 1000), ath: await sha256(token), jti: crypto.randomUUID() };
    const input = `${header}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, encoder.encode(input));
    return `${input}.${base64url(new Uint8Array(signature))}`;
  }

  async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Request> {
    return new Request(`https://district.example${path}`, {
      method,
      headers: {
        authorization: `Device ${this.tokens.accessToken}`,
        "device-proof": await this.proof(method, path, this.tokens.accessToken),
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
  }

  async refreshRequest(refreshToken = this.tokens.refreshToken): Promise<Request> {
    return new Request("https://district.example/api/m/token/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "device-proof": await this.proof("POST", "/api/m/token/refresh", refreshToken) },
      body: JSON.stringify({ refreshToken }),
    });
  }
}

/** Fetches through the Worker and reads the whole body, so the object can be restarted under no open request. */
async function fetchJson(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A phone registered for Amara through the object's RPC method, as the pairing relay will. */
async function paired(): Promise<Phone> {
  const phone = await Phone.create();
  phone.tokens = await district().registerDevice(AMARA as never, {
    publicJwk: phone.publicJwk,
    label: "Amara's Pixel",
    platform: "android",
    model: "Pixel 9",
    appVersion: "1.4.0",
  });
  return phone;
}

async function accessAssertion(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

describe("the device API in the district Worker", () => {
  it("refuses every route under /api/m without a device credential, even with a valid Access assertion", async () => {
    const assertion = await accessAssertion(AMARA);
    const failures: string[] = [];
    for (const spec of Object.values(ROUTES) as RouteSpec[]) {
      const path = `/api/m/${routePath(spec.path, Object.fromEntries(pathParameterNames(spec.path).map((name) => [name, "x"]))).slice("/api/".length)}`;
      for (const headers of [{}, { "cf-access-jwt-assertion": assertion }]) {
        const { status, body } = await fetchJson(new Request(`https://district.example${path}`, {
          method: spec.method,
          headers: { ...headers, ...(spec.method === "POST" ? { "content-type": "application/json" } : {}) },
          ...(spec.method === "POST" ? { body: "{}" } : {}),
        }));
        if (status !== 401 || body.reason !== "missing-credentials") failures.push(`${spec.method} ${path}: ${status}`);
      }
    }
    expect(failures).toStrictEqual([]);
  });

  it("serves a paired phone, rotates its refresh token, and keeps its state across a restart", async () => {
    const phone = await paired();
    const me = await fetchJson(await phone.request("GET", "/api/m/me"));
    expect(me.status).toBe(200);
    expect(ROUTES["me.get"].response.parse(me.body)).toMatchObject({ principalId: AMARA });

    // A proof replayed after the object restarts is still refused: seen proof IDs are stored.
    const first = await phone.request("GET", "/api/m/me/devices");
    const replay = new Request(first.url, { headers: first.headers });
    expect((await fetchJson(first)).status).toBe(200);
    await evictDurableObject(district());
    expect(await fetchJson(replay)).toMatchObject({ status: 401, body: { reason: "proof-replayed" } });

    const spent = phone.tokens.refreshToken;
    const refreshed = await fetchJson(await phone.refreshRequest());
    expect(refreshed.status).toBe(200);
    phone.tokens = refreshed.body as unknown as Tokens;
    expect((await fetchJson(await phone.request("GET", "/api/m/me"))).status).toBe(200);

    // The spent token, presented again after a restart, revokes the device.
    await evictDurableObject(district());
    expect(await fetchJson(await phone.refreshRequest(spent))).toMatchObject({ status: 401, body: { reason: "refresh-token-reused" } });
    expect(await fetchJson(await phone.request("GET", "/api/m/me"))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });

  it("stores devices in their own tables, and revokes through the object's RPC method and Your devices", async () => {
    const phone = await paired();
    const tables = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'educateos\\_device%' ESCAPE '\\' ORDER BY name").toArray().map((r) => r.name));
    expect(tables).toStrictEqual(["educateos_device_proofs", "educateos_device_refresh_tokens", "educateos_devices"]);

    const assertion = await accessAssertion(AMARA);
    const listed = await fetchJson(new Request("https://district.example/api/me/devices", { headers: { "cf-access-jwt-assertion": assertion } }));
    expect(listed.status).toBe(200);
    expect(ROUTES["me.devices"].response.parse(listed.body).devices.map((d) => d.id)).toContain(phone.tokens.deviceId);

    expect(await district().revokeDevice(phone.tokens.deviceId as never, { by: "prn_nf-district-admin", reason: "admin-revoked" })).toBe(true);
    expect(await fetchJson(await phone.request("GET", "/api/m/me"))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });

    const other = await paired();
    const signedOut = await fetchJson(new Request("https://district.example/api/me/devices/revoke-all", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": assertion, "content-type": "application/json" },
      body: "{}",
    }));
    expect(signedOut.status).toBe(200);
    expect((signedOut.body as { revoked: number }).revoked).toBeGreaterThanOrEqual(1);
    expect(await fetchJson(await other.request("GET", "/api/m/me"))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });
});
