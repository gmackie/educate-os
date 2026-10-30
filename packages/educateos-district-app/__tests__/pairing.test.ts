// The phone pairing relay (SCHO-261, pairing v2): rooms, the code, approval, sealing, single use,
// expiry, denial, lockout, self-rooms and the /connect-phone page, and the device API's push token.
// The enforcement table for every relay route is in devices.test.ts.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  DEVICE_PUSH_TOKEN_PATH,
  MAX_PUSH_TOKEN_LENGTH,
  PAIR_MAX_BAD_SECRETS,
  PAIR_MAX_OPEN_SELF_ROOMS,
  PAIR_ROOM_TTL_MS,
  ROUTES,
  type DeviceTokens,
} from "../src/index.ts";
import { bootDistrict, NF, type TestDistrict } from "./support.ts";
import { read, TestPhone } from "./device-support.ts";
import { claimRequest, expectedCode, phoneDevice, pollRequest, thumbprintOf, unseal, webRequest } from "./pair-support.ts";

const SECRET = "test-device-token-secret-0123456789-abcdef";
const START = Date.parse("2026-10-28T12:00:00.000Z");
const ORIGIN = "https://district.example";

type District = TestDistrict & { clock: { now: number } };

async function pairDistrict({ secret = SECRET, authority }: { secret?: string | null; authority?: "local" } = {}): Promise<District> {
  const clock = { now: START };
  const district = await bootDistrict(NORTHFIELD, {
    now: () => new Date(clock.now),
    ...(secret === null ? {} : { deviceTokenSecret: secret }),
    ...(authority === undefined ? {} : { authority }),
  });
  return Object.assign(district, { clock });
}

const fetchJson = async (district: District, request: Request) => read(await district.app.fetch(request));

async function openRoom(district: District, principalId: string = NF.amara): Promise<{ room: string; secret: string; qr: string; expiresAt: string }> {
  const created = await fetchJson(district, webRequest(district.tokenFor(principalId), "POST", "/api/pair/rooms"));
  expect(created.status).toBe(201);
  return created.body as { room: string; secret: string; qr: string; expiresAt: string };
}

const status = (district: District, room: string, principalId: string = NF.amara) =>
  fetchJson(district, webRequest(district.tokenFor(principalId), "GET", `/api/pair/rooms/${room}/status`));
const decide = (district: District, room: string, action: "approve" | "deny", principalId: string = NF.amara, body: unknown = {}) =>
  fetchJson(district, webRequest(district.tokenFor(principalId), "POST", `/api/pair/rooms/${room}/${action}`, body));

async function selfRoom(district: District, phone: TestPhone) {
  const created = await fetchJson(district, webRequest(undefined, "POST", "/api/pair/self-rooms", { publicJwk: phone.publicJwk, device: phoneDevice() }));
  expect(created.status).toBe(201);
  return created.body as { room: string; secret: string; code: string };
}

const connectUrl = async (room: string, secret: string, phone: TestPhone) =>
  `/connect-phone?method=google&r=${room}&s=${secret}&k=${await thumbprintOf(phone.publicJwk)}`;

async function pairedPhone(district: District): Promise<TestPhone> {
  const phone = await TestPhone.create(() => district.clock.now);
  phone.tokens = await district.app.devices.registerDevice(NF.amara as never, phone.registration());
  return phone;
}

describe("pairing a phone from a signed-in computer", () => {
  it("creates, claims, shows the code, approves, and hands the sealed tokens over exactly once", async () => {
    const district = await pairDistrict();
    const created = await openRoom(district);
    expect(created.room).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{22,256}$/);
    expect(created.expiresAt).toBe(new Date(START + PAIR_ROOM_TTL_MS).toISOString());
    expect(created.qr).toBe(`https://mobile.educateos.io/j#o=${encodeURIComponent(ORIGIN)}&r=${created.room}&s=${created.secret}`);
    expect(await status(district, created.room)).toStrictEqual({ status: 200, body: { state: "waiting" } });

    const phone = await TestPhone.create(() => district.clock.now);
    expect(await fetchJson(district, pollRequest(created.room, created.secret))).toStrictEqual({ status: 200, body: { state: "waiting" } });
    const claimed = await fetchJson(district, claimRequest(created.room, created.secret, phone));
    const code = await expectedCode(created.room, phone.publicJwk);
    expect(claimed).toStrictEqual({ status: 200, body: { code } });
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(await status(district, created.room)).toStrictEqual({ status: 200, body: { state: "claimed", code, device: phoneDevice() } });
    expect(await fetchJson(district, pollRequest(created.room, created.secret))).toStrictEqual({ status: 200, body: { state: "waiting" } });

    const approved = await decide(district, created.room, "approve");
    expect(approved.status).toBe(200);
    expect(approved.body.deviceId).toMatch(/^dev_/);
    expect((await status(district, created.room)).body.state).toBe("approved");

    const poll = await fetchJson(district, pollRequest(created.room, created.secret));
    expect(poll.status).toBe(200);
    expect(poll.body.state).toBe("approved");
    const sealed = poll.body.sealed as { epk: JsonWebKey; iv: string; ct: string };
    expect(sealed.epk).toStrictEqual({ kty: "EC", crv: "P-256", x: expect.any(String), y: expect.any(String) });
    const credential = await unseal(phone, created.room, sealed);
    expect(credential).toMatchObject({ deviceId: approved.body.deviceId, principalId: NF.amara, accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect(Date.parse(credential.accessTokenExpiresAt!)).toBeGreaterThan(START);
    expect(credential.accessExpiresAt).toBe(credential.accessTokenExpiresAt);

    // Single use: the next poll is gone, and the room cannot be claimed or approved again.
    expect((await fetchJson(district, pollRequest(created.room, created.secret))).status).toBe(410);
    expect((await fetchJson(district, claimRequest(created.room, created.secret, await TestPhone.create()))).status).toBe(410);
    expect((await decide(district, created.room, "approve")).status).toBe(410);

    // The tokens work on the device API, with proofs from the phone's key.
    phone.tokens = credential as unknown as DeviceTokens;
    const me = await fetchJson(district, await phone.request("GET", "/api/m/me"));
    expect(me.status).toBe(200);
    expect(ROUTES["me.get"].response.parse(me.body)).toMatchObject({ principalId: NF.amara });
    const device = await district.app.devices.store.get(credential.deviceId as never);
    expect(device).toMatchObject({ principalId: NF.amara, label: "Ava's iPhone", platform: "ios", model: "iPhone 16", appVersion: "1.4.0", keyThumbprint: await thumbprintOf(phone.publicJwk) });
  });

  it("seals to the claiming phone's key alone", async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    const phone = await TestPhone.create();
    await fetchJson(district, claimRequest(room, secret, phone));
    await decide(district, room, "approve");
    const { body } = await fetchJson(district, pollRequest(room, secret));
    const sealed = body.sealed as { epk: JsonWebKey; iv: string; ct: string };
    await expect(unseal(await TestPhone.create(), room, sealed)).rejects.toThrow();
    // The room ID is the HKDF salt: the same blob under another room's ID does not open.
    await expect(unseal(phone, `${room}x`, sealed)).rejects.toThrow();
  });

  it("expires a room nobody claims after two minutes, and a claimed one two minutes after the claim", async () => {
    const district = await pairDistrict();
    const first = await openRoom(district);
    district.clock.now += PAIR_ROOM_TTL_MS;
    expect((await status(district, first.room)).body.state).toBe("expired");
    expect(await fetchJson(district, pollRequest(first.room, first.secret))).toStrictEqual({ status: 200, body: { state: "expired" } });
    expect((await fetchJson(district, claimRequest(first.room, first.secret, await TestPhone.create()))).status).toBe(410);

    const second = await openRoom(district);
    district.clock.now += PAIR_ROOM_TTL_MS - 1000;
    expect((await fetchJson(district, claimRequest(second.room, second.secret, await TestPhone.create()))).status).toBe(200);
    district.clock.now += PAIR_ROOM_TTL_MS - 1000;
    expect((await status(district, second.room)).body.state).toBe("claimed");
    district.clock.now += 1000;
    expect((await status(district, second.room)).body.state).toBe("expired");
    expect((await decide(district, second.room, "approve")).status).toBe(410);
    expect((await fetchJson(district, pollRequest(second.room, second.secret))).body).toStrictEqual({ state: "expired" });
    expect(await district.app.devices.store.list()).toStrictEqual([]);
  });

  it("retires the person's open room when they open another", async () => {
    const district = await pairDistrict();
    const first = await openRoom(district);
    const elenas = await openRoom(district, NF.elena);
    await openRoom(district);
    expect((await status(district, first.room)).body.state).toBe("expired");
    expect((await fetchJson(district, claimRequest(first.room, first.secret, await TestPhone.create()))).status).toBe(410);
    // Another person's room is untouched.
    expect((await status(district, elenas.room, NF.elena)).body.state).toBe("waiting");
  });

  it("tells the phone when the person denies it, and registers nothing", async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    await fetchJson(district, claimRequest(room, secret, await TestPhone.create()));
    expect(await decide(district, room, "deny")).toStrictEqual({ status: 200, body: { state: "denied" } });
    expect((await status(district, room)).body.state).toBe("denied");
    expect(await fetchJson(district, pollRequest(room, secret))).toStrictEqual({ status: 200, body: { state: "denied" } });
    expect((await decide(district, room, "approve")).status).toBe(409);
    expect(await district.app.devices.store.list()).toStrictEqual([]);
  });

  it("refuses a second phone, and approval before any phone has joined", async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    expect((await decide(district, room, "approve")).status).toBe(409);
    const first = await TestPhone.create();
    expect((await fetchJson(district, claimRequest(room, secret, first))).status).toBe(200);
    const second = await fetchJson(district, claimRequest(room, secret, await TestPhone.create()));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("conflict");
    expect((await fetchJson(district, claimRequest(room, secret, first))).status).toBe(409);
  });

  it("refuses a claim whose key is not a P-256 public key or whose device description is invalid", async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    const phone = await TestPhone.create();
    for (const body of [
      { secret, publicJwk: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) }, device: phoneDevice() },
      { secret, publicJwk: { kty: "RSA", n: "x", e: "AQAB" }, device: phoneDevice() },
      { secret, publicJwk: phone.publicJwk, device: { ...phoneDevice(), platform: "windows" } },
      { secret, publicJwk: phone.publicJwk, device: { ...phoneDevice(), label: "" } },
      { secret, publicJwk: phone.publicJwk },
    ]) {
      const response = await fetchJson(district, new Request(`${ORIGIN}/api/pair/rooms/${room}/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(response).toMatchObject({ status: 400, body: { code: "validation-failed" } });
    }
    // None of them took the room.
    expect((await fetchJson(district, claimRequest(room, secret, phone))).status).toBe(200);
  });

  it(`expires a room after ${PAIR_MAX_BAD_SECRETS} wrong secrets`, async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    for (let i = 0; i < PAIR_MAX_BAD_SECRETS - 1; i++) {
      expect((await fetchJson(district, pollRequest(room, `wrong-secret-${i}-padding`))).status).toBe(403);
    }
    // Four wrong guesses leave it working.
    expect((await fetchJson(district, pollRequest(room, secret))).body).toStrictEqual({ state: "waiting" });
    expect((await fetchJson(district, claimRequest(room, "wrong-secret-last-padding", await TestPhone.create()))).status).toBe(403);
    // The fifth expires it, even for the right secret.
    expect((await fetchJson(district, pollRequest(room, secret))).body).toStrictEqual({ state: "expired" });
    expect((await fetchJson(district, claimRequest(room, secret, await TestPhone.create()))).status).toBe(410);
    expect((await status(district, room)).body.state).toBe("expired");
  });

  it("burns the sealed tokens of an approved room whose secret is being guessed", async () => {
    const district = await pairDistrict();
    const { room, secret } = await openRoom(district);
    await fetchJson(district, claimRequest(room, secret, await TestPhone.create()));
    await decide(district, room, "approve");
    for (let i = 0; i < PAIR_MAX_BAD_SECRETS; i++) await fetchJson(district, pollRequest(room, `wrong-secret-${i}-padding`));
    expect(await fetchJson(district, pollRequest(room, secret))).toStrictEqual({ status: 200, body: { state: "expired" } });
  });

  it("refuses a cross-site POST from the signed-in browser", async () => {
    const district = await pairDistrict();
    const token = district.tokenFor(NF.amara);
    const { room, secret } = await openRoom(district);
    await fetchJson(district, claimRequest(room, secret, await TestPhone.create()));
    const crossSite: Record<string, string>[] = [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of crossSite) {
      expect((await fetchJson(district, webRequest(token, "POST", `/api/pair/rooms/${room}/approve`, {}, headers))).status).toBe(403);
      expect((await fetchJson(district, webRequest(token, "POST", "/api/pair/rooms", {}, headers))).status).toBe(403);
    }
    expect((await status(district, room)).body.state).toBe("claimed");
  });

  it("puts the room back to claimed when the approver cannot register a device", async () => {
    const district = await pairDistrict({ authority: "local" });
    const { room, secret } = await openRoom(district, NF.elena);
    await fetchJson(district, claimRequest(room, secret, await TestPhone.create()));
    const elena = district.tokenFor(NF.elena);
    await district.ok(district.tokenFor(NF.admin), "admin.setPrincipalStatus", { params: { principalId: NF.elena }, body: { status: "inactive" } });
    const refused = await fetchJson(district, webRequest(elena, "POST", `/api/pair/rooms/${room}/approve`));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await district.app.devices.store.list()).toStrictEqual([]);
    await district.ok(district.tokenFor(NF.admin), "admin.setPrincipalStatus", { params: { principalId: NF.elena }, body: { status: "active" } });
    expect((await status(district, room, NF.elena)).body.state).toBe("claimed");
    expect((await decide(district, room, "approve", NF.elena)).status).toBe(200);
  });

  it("answers 503 device-auth-unavailable on every relay route without DEVICE_TOKEN_SECRET", async () => {
    const district = await pairDistrict({ secret: null });
    const token = district.tokenFor(NF.amara);
    for (const request of [
      webRequest(token, "POST", "/api/pair/rooms"),
      webRequest(token, "GET", "/api/pair/rooms/abcdefgh/status"),
      webRequest(token, "POST", "/api/pair/rooms/abcdefgh/approve"),
      webRequest(token, "POST", "/api/pair/rooms/abcdefgh/deny"),
      claimRequest("abcdefgh", "s".repeat(43), await TestPhone.create()),
      pollRequest("abcdefgh", "s".repeat(43)),
      webRequest(undefined, "POST", "/api/pair/self-rooms", { publicJwk: {}, device: phoneDevice() }),
      webRequest(undefined, "GET", "/api/pair/nope"),
    ]) {
      expect(await fetchJson(district, request)).toMatchObject({ status: 503, body: { code: "unavailable", reason: "device-auth-unavailable" } });
    }
    const page = await district.app.fetch(webRequest(token, "GET", "/connect-phone?r=abcdefgh&s=x"));
    expect(page.status).toBe(503);
    await page.text();
  });
});

describe("pairing a phone without a computer (self-rooms and /connect-phone)", () => {
  it("lets the signed-in person approve their phone on the connect page, then hands the phone its tokens", async () => {
    const district = await pairDistrict();
    const phone = await TestPhone.create(() => district.clock.now);
    const { room, secret, code } = await selfRoom(district, phone);
    expect(code).toBe(await expectedCode(room, phone.publicJwk));
    expect(await fetchJson(district, pollRequest(room, secret))).toStrictEqual({ status: 200, body: { state: "waiting" } });

    const response = await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", await connectUrl(room, secret, phone)));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const csp = response.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain("Approve this phone?");
    expect(html).toContain(`${code.slice(0, 4)}·${code.slice(4)}`);
    expect(html).toContain("Ava&#39;s iPhone");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain("prefers-color-scheme: dark");
    const next = `https://mobile.educateos.io/j#o=${encodeURIComponent(ORIGIN)}&amp;r=${room}&amp;s=${secret}`;
    expect(html).toContain(`data-next="${next}"`);

    // What the page's Approve button posts.
    const approved = await decide(district, room, "approve", NF.amara, { secret });
    expect(approved.status).toBe(200);
    const poll = await fetchJson(district, pollRequest(room, secret));
    const credential = await unseal(phone, room, poll.body.sealed as { epk: JsonWebKey; iv: string; ct: string });
    expect(credential).toMatchObject({ principalId: NF.amara, deviceId: approved.body.deviceId });
    phone.tokens = credential as unknown as DeviceTokens;
    expect((await fetchJson(district, await phone.request("GET", "/api/m/me"))).status).toBe(200);
    // The approver became the room's creator.
    expect((await status(district, room)).body.state).toBe("approved");
  });

  it("needs the room secret to decide a self-room, and the phone's own key thumbprint to show it", async () => {
    const district = await pairDistrict();
    const phone = await TestPhone.create();
    const { room, secret } = await selfRoom(district, phone);
    expect((await decide(district, room, "approve")).status).toBe(404);
    expect((await decide(district, room, "approve", NF.amara, { secret: "B".repeat(43) })).status).toBe(403);
    expect((await status(district, room)).status).toBe(404);
    // A self-room cannot be claimed by another phone.
    expect((await fetchJson(district, claimRequest(room, secret, await TestPhone.create()))).status).toBe(409);

    const other = await TestPhone.create();
    const mismatch = await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", await connectUrl(room, secret, other)));
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).not.toContain("Approve this phone?");
    const unsigned = await district.app.fetch(webRequest(undefined, "GET", await connectUrl(room, secret, phone)));
    expect(unsigned.status).toBe(401);
    expect(await unsigned.text()).not.toContain(secret);
    const malformed = await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", `/connect-phone?r=${room}&s=short&k=x`));
    expect(malformed.status).toBe(400);
    await malformed.text();

    // Denying it on the page tells the phone.
    expect(await decide(district, room, "deny", NF.amara, { secret })).toStrictEqual({ status: 200, body: { state: "denied" } });
    expect((await fetchJson(district, pollRequest(room, secret))).body).toStrictEqual({ state: "denied" });
    const decided = await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", await connectUrl(room, secret, phone)));
    expect(decided.status).toBe(410);
    await decided.text();
  });

  it("expires a self-room two minutes after it is made", async () => {
    const district = await pairDistrict();
    const phone = await TestPhone.create();
    const { room, secret } = await selfRoom(district, phone);
    district.clock.now += PAIR_ROOM_TTL_MS;
    const page = await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", await connectUrl(room, secret, phone)));
    expect(page.status).toBe(410);
    await page.text();
    expect((await decide(district, room, "approve", NF.amara, { secret })).status).toBe(410);
    expect((await fetchJson(district, pollRequest(room, secret))).body).toStrictEqual({ state: "expired" });
  });

  it("validates the phone's key and caps how many self-rooms may be open at once", async () => {
    const district = await pairDistrict();
    const invalid = await fetchJson(district, webRequest(undefined, "POST", "/api/pair/self-rooms", { publicJwk: { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) }, device: phoneDevice() }));
    expect(invalid).toMatchObject({ status: 400, body: { code: "validation-failed" } });
    const phone = await TestPhone.create();
    for (let i = 0; i < PAIR_MAX_OPEN_SELF_ROOMS; i++) await selfRoom(district, phone);
    const capped = await fetchJson(district, webRequest(undefined, "POST", "/api/pair/self-rooms", { publicJwk: phone.publicJwk, device: phoneDevice() }));
    expect(capped).toMatchObject({ status: 429, body: { reason: "too-many-rooms" } });
    // Once they expire there is room again.
    district.clock.now += PAIR_ROOM_TTL_MS;
    await selfRoom(district, phone);
  });
});

describe("the device API's push token", () => {
  it("stores a valid Expo push token on the device and clears it", async () => {
    const district = await pairDistrict();
    const phone = await pairedPhone(district);
    const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
    const set = await district.app.fetch(await phone.request("POST", DEVICE_PUSH_TOKEN_PATH, { body: { token, provider: "expo", platform: "ios" } }));
    expect(set.status).toBe(204);
    expect((await district.app.devices.store.get(phone.tokens!.deviceId))!.pushToken).toBe(token);
    expect((await district.ok(district.tokenFor(NF.amara), "me.devices")).devices[0]).toMatchObject({ push: true });

    const cleared = await district.app.fetch(await phone.request("DELETE", DEVICE_PUSH_TOKEN_PATH));
    expect(cleared.status).toBe(204);
    expect((await district.app.devices.store.get(phone.tokens!.deviceId))!.pushToken).toBeNull();
  });

  it("refuses anything but an Expo push token of at most 256 characters", async () => {
    const district = await pairDistrict();
    const phone = await pairedPhone(district);
    for (const body of [
      { token: "not-a-token", provider: "expo" },
      { token: "ExponentPushToken[]", provider: "expo" },
      { token: "ExponentPushToken[abc] trailing", provider: "expo" },
      { token: "ExponentPushToken[<script>]", provider: "expo" },
      { token: `ExponentPushToken[${"a".repeat(MAX_PUSH_TOKEN_LENGTH)}]`, provider: "expo" },
      { token: "ExponentPushToken[abc]", provider: "fcm" },
      { token: "ExponentPushToken[abc]" },
      { token: 42, provider: "expo" },
    ]) {
      const response = await read(await district.app.fetch(await phone.request("POST", DEVICE_PUSH_TOKEN_PATH, { body })));
      expect(response).toMatchObject({ status: 400, body: { code: "validation-failed" } });
    }
    expect((await district.app.devices.store.get(phone.tokens!.deviceId))!.pushToken).toBeNull();
  });

  it("is the device's own: the web API has no push token route", async () => {
    const district = await pairDistrict();
    const response = await read(await district.app.fetch(webRequest(district.tokenFor(NF.amara), "POST", "/api/me/devices/push-token", { token: "ExponentPushToken[abc]", provider: "expo" })));
    expect(response.status).toBe(404);
  });
});
