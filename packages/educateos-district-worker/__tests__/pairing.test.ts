// The pairing relay in workerd (SCHO-261): a whole pairing through the Worker's own fetch handler,
// over the district's real SQLite Durable Object, with the object restarted between every step. The
// relay's full behaviour and its enforcement table are in @educateos/district-app's tests.
//
// Every response body is read before the object is evicted, or the eviction waits on it.
import { env, evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { ROUTES } from "@educateos/district-app/routes";
import { ACCESS_AUDIENCE, ACCESS_ISSUER } from "./fixtures.ts";

const AMARA = "prn_nf-student-amara";
const ORIGIN = "https://district.example";
const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);
const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const sha256 = async (text: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

async function accessAssertion(principalId: string): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Fetches through the Worker and reads the whole body. */
async function fetchJson(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** A phone's key, for proofs and for opening the sealed tokens. */
async function phoneKey() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
  return { keys, publicJwk: { kty, crv, x, y } };
}

async function unseal(privateKey: CryptoKey, room: string, sealed: { epk: JsonWebKey; iv: string; ct: string }): Promise<Record<string, string>> {
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey) as JsonWebKey;
  const own = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const epk = await crypto.subtle.importKey("jwk", sealed.epk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, own, 256);
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(room), info: encoder.encode("educateos-pair-v2") },
    ikm, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(sealed.iv) }, key, fromBase64url(sealed.ct));
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
}

async function deviceRequest(keys: CryptoKeyPair, accessToken: string, path: string): Promise<Request> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", typ: "device-proof+jwt" })));
  const claims = { htm: "GET", htu: path, iat: Math.floor(Date.now() / 1000), ath: await sha256(accessToken), jti: crypto.randomUUID() };
  const input = `${header}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(input));
  return new Request(`${ORIGIN}${path}`, { headers: { authorization: `Device ${accessToken}`, "device-proof": `${input}.${base64url(new Uint8Array(signature))}` } });
}

const device = { label: "Amara's Pixel", platform: "android", model: "Pixel 9", appVersion: "1.4.0" };

describe("the pairing relay in the district Worker", () => {
  it("pairs a phone across restarts of the district object, handing the tokens over once", async () => {
    // The browser's sign-in, as Access sends it on a bypass path: the cookie, not the header.
    const cookie = `CF_Authorization=${await accessAssertion(AMARA)}`;
    const web = (method: "GET" | "POST", path: string) => new Request(`${ORIGIN}${path}`, {
      method,
      headers: { cookie, ...(method === "POST" ? { "content-type": "application/json", origin: ORIGIN } : {}) },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

    const created = await fetchJson(web("POST", "/api/pair/rooms"));
    expect(created.status).toBe(201);
    const { room, secret } = created.body as { room: string; secret: string };
    await evictDurableObject(district());

    const phone = await phoneKey();
    const claimed = await fetchJson(new Request(`${ORIGIN}/api/pair/rooms/${room}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, publicJwk: phone.publicJwk, device }),
    }));
    expect(claimed.status).toBe(200);
    await evictDurableObject(district());

    const status = await fetchJson(web("GET", `/api/pair/rooms/${room}/status`));
    expect(status).toStrictEqual({ status: 200, body: { state: "claimed", code: claimed.body.code, device } });
    await evictDurableObject(district());

    const approved = await fetchJson(web("POST", `/api/pair/rooms/${room}/approve`));
    expect(approved.status).toBe(200);
    await evictDurableObject(district());

    const poll = await fetchJson(new Request(`${ORIGIN}/api/pair/rooms/${room}?secret=${secret}`));
    expect(poll.body.state).toBe("approved");
    await evictDurableObject(district());
    expect((await fetchJson(new Request(`${ORIGIN}/api/pair/rooms/${room}?secret=${secret}`))).status).toBe(410);

    const credential = await unseal(phone.keys.privateKey, room, poll.body.sealed as { epk: JsonWebKey; iv: string; ct: string });
    expect(credential).toMatchObject({ deviceId: approved.body.deviceId, principalId: AMARA });
    const me = await fetchJson(await deviceRequest(phone.keys, credential.accessToken!, "/api/m/me"));
    expect(me.status).toBe(200);
    expect(ROUTES["me.get"].response.parse(me.body)).toMatchObject({ principalId: AMARA });

    const tables = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'educateos_pair_rooms'").toArray().map((r) => r.name));
    expect(tables).toStrictEqual(["educateos_pair_rooms"]);
  });

  it("serves /connect-phone behind the district's sign-in, for a phone's self-room", async () => {
    const phone = await phoneKey();
    const created = await fetchJson(new Request(`${ORIGIN}/api/pair/self-rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicJwk: phone.publicJwk, device }),
    }));
    expect(created.status).toBe(201);
    const { room, secret, code } = created.body as { room: string; secret: string; code: string };
    await evictDurableObject(district());

    const thumbprint = await sha256(JSON.stringify({ crv: phone.publicJwk.crv, kty: phone.publicJwk.kty, x: phone.publicJwk.x, y: phone.publicJwk.y }));
    const path = `/connect-phone?method=google&r=${room}&s=${secret}&k=${thumbprint}`;
    const unsigned = await SELF.fetch(`${ORIGIN}${path}`);
    expect(unsigned.status).toBe(401);
    await unsigned.text();

    const assertion = await accessAssertion(AMARA);
    const page = await SELF.fetch(`${ORIGIN}${path}`, { headers: { "cf-access-jwt-assertion": assertion } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/);
    const html = await page.text();
    expect(html).toContain("Approve this phone?");
    expect(html).toContain(`${code.slice(0, 4)}·${code.slice(4)}`);
    await evictDurableObject(district());

    // The page's Approve button: same origin, with the self-room's secret.
    const approved = await fetchJson(new Request(`${ORIGIN}/api/pair/rooms/${room}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "cf-access-jwt-assertion": assertion },
      body: JSON.stringify({ secret }),
    }));
    expect(approved.status).toBe(200);
    await evictDurableObject(district());
    const poll = await fetchJson(new Request(`${ORIGIN}/api/pair/rooms/${room}?secret=${secret}`));
    expect(poll.body.state).toBe("approved");
    expect(await unseal(phone.keys.privateKey, room, poll.body.sealed as { epk: JsonWebKey; iv: string; ct: string })).toMatchObject({ principalId: AMARA });
  });

  it("stores a push token through the Worker", async () => {
    const phone = await phoneKey();
    const tokens = await district().registerDevice(AMARA as never, { publicJwk: phone.publicJwk, ...device, platform: "android" });
    const path = "/api/m/me/devices/push-token";
    const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", typ: "device-proof+jwt" })));
    const claims = { htm: "POST", htu: path, iat: Math.floor(Date.now() / 1000), ath: await sha256(tokens.accessToken), jti: crypto.randomUUID() };
    const input = `${header}.${base64url(encoder.encode(JSON.stringify(claims)))}`;
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, phone.keys.privateKey, encoder.encode(input));
    const response = await SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { authorization: `Device ${tokens.accessToken}`, "device-proof": `${input}.${base64url(new Uint8Array(signature))}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "ExponentPushToken[abcdefghijklmnop]", provider: "expo", platform: "android" }),
    });
    expect(response.status).toBe(204);
    await response.arrayBuffer();
    await evictDurableObject(district());
    const stored = await runInDurableObject(district(), async (_instance, state) =>
      state.storage.sql.exec("SELECT push_token FROM educateos_devices WHERE id = ?", tokens.deviceId).toArray()[0]?.push_token);
    expect(stored).toBe("ExponentPushToken[abcdefghijklmnop]");
  });
});
