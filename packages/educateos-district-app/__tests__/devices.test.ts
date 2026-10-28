// Device identity (SCHO-261): registration, the /api/m device API's one choke point, refresh token
// rotation and reuse detection, proof replay, revocation, and Your devices.
import { beforeAll, describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import {
  ACCESS_TOKEN_TTL_MS,
  DEVICE_PUSH_TOKEN_PATH,
  DEVICE_REFRESH_PATH,
  REFRESH_TOKEN_TTL_MS,
  ROUTES,
  routePath,
  pathParameterNames,
  type DeviceTokens,
  type DistrictApp,
  type RouteSpec,
} from "../src/index.ts";
import { bootDistrict, expectError, NF, type TestDistrict } from "./support.ts";
import { read, TestPhone } from "./device-support.ts";
import { claimRequest, pollRequest, webRequest } from "./pair-support.ts";

const SECRET = "test-device-token-secret-0123456789-abcdef";
const START = Date.parse("2026-10-28T12:00:00.000Z");

/** A district whose clock the test moves, with device sign-in configured. */
async function deviceDistrict(
  { secret = SECRET, authority }: { secret?: string | null; authority?: "local" } = {},
): Promise<TestDistrict & { clock: { now: number } }> {
  const clock = { now: START };
  const district = await bootDistrict(NORTHFIELD, {
    now: () => new Date(clock.now),
    ...(secret === null ? {} : { deviceTokenSecret: secret }),
    // A district that authors its own people, so an administrator can deactivate one here.
    ...(authority === undefined ? {} : { authority }),
  });
  return Object.assign(district, { clock });
}

/** A phone registered for `principalId`, its proofs dated by the district's clock. */
async function pairedPhone(district: { app: DistrictApp; clock: { now: number } }, principalId: string): Promise<TestPhone> {
  const phone = await TestPhone.create(() => district.clock.now);
  phone.tokens = await district.app.devices.registerDevice(principalId as never, phone.registration());
  return phone;
}

// ---------------------------------------------------------------------------------------------
// Generated enforcement: every route under an Access bypass path refuses every bad credential.
//
// Each surface lists every route reachable under its prefix and the requests that must each be
// refused with 401 before any handler runs. The pairing relay's routes (/api/pair) have their own
// table below, since its phone endpoints answer a bad room secret with 403 or 404 rather than 401.
// /api/ops (the signed operations API) joins this table when it lands.
// ---------------------------------------------------------------------------------------------

interface BypassRoute {
  method: "GET" | "POST" | "DELETE";
  path: string;
}

interface Fixture {
  district: Awaited<ReturnType<typeof deviceDistrict>>;
  active: TestPhone;
  revoked: TestPhone;
  expired: TestPhone;
  stranger: TestPhone;
}

interface BypassSurface {
  name: string;
  routes(): BypassRoute[];
  /** Each refusal builds the request for one route, and names the reason the 401 must give. */
  refusals: Record<string, { reason: string; request(fixture: Fixture, route: BypassRoute): Promise<Request> }>;
}

/** Every web API route, as the device API serves it: `/api/<rest>` at `/api/m/<rest>`. */
function deviceApiRoutes(): BypassRoute[] {
  const mapped = (Object.values(ROUTES) as RouteSpec[]).map((spec) => ({
    method: spec.method,
    path: `/api/m/${routePath(spec.path, Object.fromEntries(pathParameterNames(spec.path).map((name) => [name, "x"]))).slice("/api/".length)}`,
  }));
  // Paths no route serves are refused just the same: the credential is checked before matching.
  const unmatched: BypassRoute[] = ["/api/m", "/api/m/", "/api/m/nope", "/api/m/lti/registrations", "/api/m/calendar/x.ics"]
    .map((path) => ({ method: "GET", path }));
  // The device's own endpoints, which no web API route mirrors.
  const own: BypassRoute[] = [{ method: "POST", path: DEVICE_PUSH_TOKEN_PATH }, { method: "DELETE", path: DEVICE_PUSH_TOKEN_PATH }];
  return [...mapped, ...unmatched, ...own, { method: "GET", path: DEVICE_REFRESH_PATH }];
}

const plainRequest = (route: BypassRoute, headers: Record<string, string> = {}) => new Request(`https://district.example${route.path}`, {
  method: route.method,
  headers: route.method === "POST" ? { ...headers, "content-type": "application/json" } : headers,
  ...(route.method === "POST" ? { body: "{}" } : {}),
});

const BYPASS_SURFACES: BypassSurface[] = [
  {
    name: "the device API (/api/m)",
    routes: deviceApiRoutes,
    refusals: {
      "no credentials": { reason: "missing-credentials", request: async (_f, route) => plainRequest(route) },
      "an Access-style bearer token": { reason: "missing-credentials", request: async (_f, route) => plainRequest(route, { authorization: "Bearer anything" }) },
      "a token without a proof": {
        reason: "missing-credentials",
        request: async (f, route) => plainRequest(route, { authorization: `Device ${f.active.tokens!.accessToken}` }),
      },
      "a valid token and a proof signed by another key": {
        reason: "invalid-proof",
        request: (f, route) => f.active.request(route.method, route.path, { key: f.stranger.keys.privateKey }),
      },
      "a valid token and a proof for another path": {
        reason: "invalid-proof",
        request: async (f, route) => {
          const request = await f.active.request(route.method, route.path, { proof: { htu: "/api/m/me" } });
          return route.path === "/api/m/me" ? f.active.request(route.method, route.path, { proof: { htu: "/api/m/other" } }) : request;
        },
      },
      "a forged token": {
        reason: "invalid-token",
        request: (f, route) => f.active.request(route.method, route.path, { accessToken: `${f.active.tokens!.accessToken.slice(0, -4)}AAAA` }),
      },
      "a revoked device": { reason: "device-revoked", request: (f, route) => f.revoked.request(route.method, route.path) },
      "an expired token": { reason: "token-expired", request: (f, route) => f.expired.request(route.method, route.path) },
    },
  },
  {
    name: "the device token endpoint",
    routes: () => [{ method: "POST", path: DEVICE_REFRESH_PATH }],
    refusals: {
      "no credentials": { reason: "missing-credentials", request: async (_f, route) => plainRequest(route) },
      "a refresh token without a proof": { reason: "missing-credentials", request: (f) => f.active.refreshRequest({ noProof: true }) },
      "a refresh token and a proof signed by another key": { reason: "invalid-proof", request: (f) => f.active.refreshRequest({ key: f.stranger.keys.privateKey }) },
      "an unknown refresh token": { reason: "invalid-refresh-token", request: (f) => f.active.refreshRequest({ refreshToken: "not-a-refresh-token" }) },
      "a revoked device": { reason: "device-revoked", request: (f) => f.revoked.refreshRequest() },
    },
  },
];

describe("every route under a bypass path", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    const district = await deviceDistrict();
    const expired = await pairedPhone(district, NF.amara);
    district.clock.now += ACCESS_TOKEN_TTL_MS + 1000;
    const active = await pairedPhone(district, NF.amara);
    const revoked = await pairedPhone(district, NF.amara);
    await district.app.devices.revoke(revoked.tokens!.deviceId, { by: "system", reason: "admin-revoked" });
    const stranger = await TestPhone.create(() => district.clock.now);
    fixture = { district, active, revoked, expired, stranger };
  });

  it("covers every web API route and the device endpoints", () => {
    const paths = new Set(deviceApiRoutes().map((r) => `${r.method} ${r.path}`));
    expect(paths.size).toBeGreaterThanOrEqual(Object.keys(ROUTES).length);
    for (const route of ["GET /api/m/me", "GET /api/m/me/devices", "POST /api/m/me/devices/x/revoke", "POST /api/m/admin/principals/x/status", `POST ${DEVICE_PUSH_TOKEN_PATH}`, `DELETE ${DEVICE_PUSH_TOKEN_PATH}`]) {
      expect(paths).toContain(route);
    }
  });

  for (const surface of BYPASS_SURFACES) {
    describe(surface.name, () => {
      for (const [scenario, refusal] of Object.entries(surface.refusals)) {
        it(`answers 401 ${refusal.reason} to ${scenario}, on every route`, async () => {
          const failures: string[] = [];
          for (const route of surface.routes()) {
            const { status, body } = await read(await fixture.district.app.fetch(await refusal.request(fixture, route)));
            if (status !== 401 || body.code !== "unauthenticated" || body.reason !== refusal.reason) {
              failures.push(`${route.method} ${route.path}: ${status} ${JSON.stringify(body)}`);
            }
          }
          expect(failures).toStrictEqual([]);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Generated enforcement for the pairing relay (/api/pair, SCHO-261), also under an Access bypass.
//
// The phone's endpoints are authenticated by the room secret alone: every bad secret is a 403 (or a
// 404 for a room that does not exist) and its body carries no room state, code or sealed tokens.
// The browser's endpoints need the district's web sign-in (401 without it, whatever else is sent)
// and answer only the room's creator (404 for anyone else).
// ---------------------------------------------------------------------------------------------

interface PairRouteCase {
  name: string;
  request(room: string, secret: string | undefined, phone: TestPhone): Request;
}

const PAIR_PHONE_ROUTES: PairRouteCase[] = [
  { name: "POST /api/pair/rooms/:room/claim", request: (room, secret, phone) => claimRequest(room, secret, phone) },
  { name: "GET /api/pair/rooms/:room", request: (room, secret) => pollRequest(room, secret) },
];

const PAIR_BROWSER_ROUTES: { name: string; request(token: string | undefined, room: string, headers?: Record<string, string>): Request }[] = [
  { name: "POST /api/pair/rooms", request: (token, _room, headers) => webRequest(token, "POST", "/api/pair/rooms", {}, headers) },
  { name: "GET /api/pair/rooms/:room/status", request: (token, room, headers) => webRequest(token, "GET", `/api/pair/rooms/${room}/status`, undefined, headers) },
  { name: "POST /api/pair/rooms/:room/approve", request: (token, room, headers) => webRequest(token, "POST", `/api/pair/rooms/${room}/approve`, {}, headers) },
  { name: "POST /api/pair/rooms/:room/deny", request: (token, room, headers) => webRequest(token, "POST", `/api/pair/rooms/${room}/deny`, {}, headers) },
];

/** No refusal may say anything about a room: its `code` is an error code, never a pairing code. */
function expectNoRoomData(body: Record<string, unknown>): void {
  for (const key of ["state", "sealed", "device", "room", "secret", "deviceId", "qr"]) expect(body).not.toHaveProperty(key);
  expect(body.code).toMatch(/^[a-z]+(-[a-z]+)*$/);
}

describe("every route of the pairing relay", () => {
  let district: Awaited<ReturnType<typeof deviceDistrict>>;
  let phone: TestPhone;
  /** A room opened by Amara, its secret, and a phone already claimed into a second one. */
  const openRoom = async () => {
    const created = await read(await district.app.fetch(webRequest(district.tokenFor(NF.amara), "POST", "/api/pair/rooms")));
    expect(created.status).toBe(201);
    return { room: created.body.room as string, secret: created.body.secret as string };
  };
  beforeAll(async () => {
    district = await deviceDistrict();
    phone = await TestPhone.create(() => district.clock.now);
  });

  const refusals: Record<string, { expected: number[]; secret(own: string, other: string): string | undefined }> = {
    "no secret": { expected: [403], secret: () => undefined },
    "a wrong secret": { expected: [403], secret: () => "A".repeat(43) },
    "another room's secret": { expected: [403], secret: (_own, other) => other },
    "a malformed secret": { expected: [403], secret: () => "short" },
  };

  for (const route of PAIR_PHONE_ROUTES) {
    for (const [scenario, refusal] of Object.entries(refusals)) {
      it(`${route.name} answers ${refusal.expected.join(" or ")} to ${scenario}, with no room data`, async () => {
        const own = await openRoom();
        // A second person's room, so the room above stays Amara's open one.
        const other = await read(await district.app.fetch(webRequest(district.tokenFor(NF.elena), "POST", "/api/pair/rooms")));
        const { status, body } = await read(await district.app.fetch(route.request(own.room, refusal.secret(own.secret, other.body.secret as string), phone)));
        expect(refusal.expected).toContain(status);
        expectNoRoomData(body);
      });
    }
    it(`${route.name} answers 404 for a room that does not exist, whatever the secret`, async () => {
      const own = await openRoom();
      for (const room of ["unknownroom1", "x", "../status", `${own.room}X`]) {
        const { status, body } = await read(await district.app.fetch(route.request(encodeURIComponent(room), own.secret, phone)));
        expect(status).toBe(404);
        expectNoRoomData(body);
      }
    });
  }

  for (const route of PAIR_BROWSER_ROUTES) {
    it(`${route.name} answers 401 without the web sign-in, even with a device credential or the room secret`, async () => {
      const own = await openRoom();
      const paired = await pairedPhone(district, NF.amara);
      const deviceHeaders = { authorization: `Device ${paired.tokens!.accessToken}`, "device-proof": await paired.proof("POST", "/api/pair/rooms", paired.tokens!.accessToken) };
      for (const request of [
        route.request(undefined, own.room),
        route.request(undefined, own.room, { authorization: "Bearer not-a-token" }),
        route.request(undefined, own.room, deviceHeaders),
      ]) {
        const { status, body } = await read(await district.app.fetch(request));
        expect({ status, code: body.code }).toStrictEqual({ status: 401, code: "unauthenticated" });
        expectNoRoomData(body);
      }
    });
    if (route.name !== "POST /api/pair/rooms") {
      it(`${route.name} answers 404 to anyone but the room's creator`, async () => {
        const own = await openRoom();
        await read(await district.app.fetch(claimRequest(own.room, own.secret, await TestPhone.create())));
        for (const someone of [NF.elena, NF.admin]) {
          const { status, body } = await read(await district.app.fetch(route.request(district.tokenFor(someone), own.room)));
          expect(status).toBe(404);
          expectNoRoomData(body);
        }
        // Still Amara's to decide.
        expect((await read(await district.app.fetch(webRequest(district.tokenFor(NF.amara), "GET", `/api/pair/rooms/${own.room}/status`)))).body.state).toBe("claimed");
      });
    }
  }
});

describe("the device API", () => {
  it("serves the web API's routes as the device's principal", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const viaDevice = await read(await district.app.fetch(await phone.request("GET", "/api/m/me")));
    const viaWeb = await district.ok(district.tokenFor(NF.amara), "me.get");
    expect(viaDevice.status).toBe(200);
    expect(ROUTES["me.get"].response.parse(viaDevice.body)).toStrictEqual(viaWeb);

    // A write, with its body, through the same handler.
    const workspace = await read(await district.app.fetch(await phone.request("POST", "/api/m/student/workspaces/personal")));
    expect(workspace.status).toBe(200);
    ROUTES["student.openPersonalWorkspace"].response.parse(workspace.body);
  });

  it("applies the same policy: a device cannot act outside its principal's permissions", async () => {
    const district = await deviceDistrict();
    const student = await pairedPhone(district, NF.amara);
    for (const path of ["/api/m/admin/health", "/api/m/teacher/offerings"]) {
      expect(await read(await district.app.fetch(await student.request("GET", path)))).toMatchObject({ status: 403, body: { code: "forbidden" } });
    }
    const forbidden = await read(await district.app.fetch(await student.request("POST", `/api/m/admin/principals/${NF.elena}/status`, { body: { status: "inactive" } })));
    expect(forbidden).toMatchObject({ status: 403, body: { code: "forbidden" } });
    // Onboarding is someone's who is nobody's principal yet; a device always is one.
    const onboarding = await read(await district.app.fetch(await student.request("POST", "/api/m/onboarding/guardian-invitations/preview", { body: { token: "x" } })));
    expect(onboarding).toMatchObject({ status: 403, body: { code: "forbidden" } });
  });

  it("refuses a replayed proof, a stale one, and one for another method or token", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const first = await phone.request("GET", "/api/m/me");
    const replay = new Request(first.url, { headers: first.headers });
    expect((await read(await district.app.fetch(first))).status).toBe(200);
    expect(await read(await district.app.fetch(replay))).toMatchObject({ status: 401, body: { reason: "proof-replayed" } });

    const stale = Math.floor(district.clock.now / 1000) - 61;
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me", { proof: { iat: stale } })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    const future = Math.floor(district.clock.now / 1000) + 61;
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me", { proof: { iat: future } })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me", { proof: { htm: "POST" } })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me", { proof: { ath: "x".repeat(43) } })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    // A proof of the right age still passes once its minute is up; its jti is long forgotten by then.
    district.clock.now += 59_000;
    expect((await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).status).toBe(200);
  });

  it("refuses another device's token presented with this device's proof", async () => {
    const district = await deviceDistrict();
    const ava = await pairedPhone(district, NF.amara);
    const thief = await pairedPhone(district, NF.elena);
    const request = await thief.request("GET", "/api/m/me", { accessToken: ava.tokens!.accessToken });
    expect(await read(await district.app.fetch(request))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
  });

  it("records last seen at most once a minute, with the request's country", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const seen = async () => (await district.app.devices.store.get(phone.tokens!.deviceId))!;
    const withCountry = async (country: string) => {
      const request = await phone.request("GET", "/api/m/me");
      const headers = new Headers(request.headers);
      headers.set("cf-ipcountry", country);
      return new Request(request.url, { headers });
    };
    district.clock.now += 30_000;
    await read(await district.app.fetch(await withCountry("US")));
    expect((await seen()).lastSeenAt).toBe(new Date(START).toISOString());
    district.clock.now += 31_000;
    await read(await district.app.fetch(await withCountry("CA")));
    expect(await seen()).toMatchObject({ lastSeenAt: new Date(START + 61_000).toISOString(), lastCountry: "CA" });
  });

  it("answers 503 device-auth-unavailable without a usable DEVICE_TOKEN_SECRET", async () => {
    for (const secret of [null, "too-short"]) {
      const district = await deviceDistrict({ secret });
      expect(district.app.devices.available).toBe(false);
      for (const path of ["/api/m/me", DEVICE_REFRESH_PATH]) {
        const response = await read(await district.app.fetch(new Request(`https://district.example${path}`, { method: "POST", body: "{}" })));
        expect(response).toMatchObject({ status: 503, body: { code: "unavailable", reason: "device-auth-unavailable" } });
      }
      const phone = await TestPhone.create();
      await expect(district.app.devices.registerDevice(NF.amara as never, phone.registration())).rejects.toMatchObject({ code: "unavailable" });
      // The web API is unaffected.
      expect((await district.call(district.tokenFor(NF.amara), "me.devices")).status).toBe(200);
    }
  });
});

describe("device registration", () => {
  it("issues a 15-minute access token and a 30-day refresh token for an active principal", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    expect(phone.tokens).toMatchObject({
      deviceId: expect.stringMatching(/^dev_/),
      accessTokenExpiresAt: new Date(START + ACCESS_TOKEN_TTL_MS).toISOString(),
      refreshTokenExpiresAt: new Date(START + REFRESH_TOKEN_TTL_MS).toISOString(),
    });
    const device = (await district.app.devices.store.get(phone.tokens!.deviceId))!;
    expect(device).toMatchObject({ principalId: NF.amara, label: "Ava's iPhone", platform: "ios", model: "iPhone 16", appVersion: "1.4.0", status: "active" });
    expect(device.keyThumbprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("refuses an inactive or unknown principal, a key that is not P-256, and a key already registered", async () => {
    const district = await deviceDistrict({ authority: "local" });
    const phone = await TestPhone.create();
    await expect(district.app.devices.registerDevice("prn_nobody" as never, phone.registration())).rejects.toMatchObject({ code: "unauthenticated" });
    await district.ok(district.tokenFor(NF.admin), "admin.setPrincipalStatus", { params: { principalId: NF.elena }, body: { status: "inactive" } });
    await expect(district.app.devices.registerDevice(NF.elena as never, phone.registration())).rejects.toMatchObject({ code: "unauthenticated" });
    const rsa = { kty: "RSA", n: "x", e: "AQAB" };
    await expect(district.app.devices.registerDevice(NF.amara as never, { ...phone.registration(), publicJwk: rsa })).rejects.toMatchObject({ code: "validation-failed" });
    const offCurve = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) };
    await expect(district.app.devices.registerDevice(NF.amara as never, { ...phone.registration(), publicJwk: offCurve })).rejects.toMatchObject({ code: "validation-failed" });
    await district.app.devices.registerDevice(NF.amara as never, phone.registration());
    await expect(district.app.devices.registerDevice(NF.amara as never, phone.registration())).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("refresh tokens", () => {
  it("rotate on every use and slide the 30-day expiry", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const first = phone.tokens!;
    district.clock.now += 20 * 24 * 60 * 60 * 1000;
    const refreshed = await read(await district.app.fetch(await phone.refreshRequest()));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({ deviceId: first.deviceId });
    expect(refreshed.body.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.body.accessToken).not.toBe(first.accessToken);
    phone.tokens = refreshed.body as unknown as DeviceTokens;
    expect((await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).status).toBe(200);
    // 45 days after registration, 25 after the last rotation: still alive.
    district.clock.now += 25 * 24 * 60 * 60 * 1000;
    const again = await read(await district.app.fetch(await phone.refreshRequest()));
    expect(again.status).toBe(200);
    phone.tokens = again.body as unknown as DeviceTokens;
    // Thirty days without a refresh, and it has expired.
    district.clock.now += REFRESH_TOKEN_TTL_MS;
    expect(await read(await district.app.fetch(await phone.refreshRequest()))).toMatchObject({ status: 401, body: { reason: "refresh-token-expired" } });
  });

  it("revoke the device when a spent one is presented again", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const spent = phone.tokens!.refreshToken;
    const refreshed = await read(await district.app.fetch(await phone.refreshRequest()));
    phone.tokens = refreshed.body as unknown as DeviceTokens;

    const reuse = await read(await district.app.fetch(await phone.refreshRequest({ refreshToken: spent })));
    expect(reuse).toMatchObject({ status: 401, body: { reason: "refresh-token-reused" } });
    expect(await district.app.devices.store.get(phone.tokens!.deviceId)).toMatchObject({ status: "revoked", revokedReason: "refresh-token-reuse", revokedBy: "system" });
    // The legitimate holder's newer tokens die with it.
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    expect(await read(await district.app.fetch(await phone.refreshRequest()))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });

  it("are not spent, nor the device revoked, by a request without the device's key", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const stranger = await TestPhone.create(() => district.clock.now);
    const spent = phone.tokens!.refreshToken;
    phone.tokens = (await read(await district.app.fetch(await phone.refreshRequest()))).body as unknown as DeviceTokens;
    // A copy of the spent token without the key cannot revoke the device...
    expect(await read(await district.app.fetch(await phone.refreshRequest({ refreshToken: spent, key: stranger.keys.privateKey })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    // ...nor spend the live one.
    expect(await read(await district.app.fetch(await phone.refreshRequest({ key: stranger.keys.privateKey })))).toMatchObject({ status: 401, body: { reason: "invalid-proof" } });
    expect((await read(await district.app.fetch(await phone.refreshRequest()))).status).toBe(200);
  });

  it("refuse a replayed refresh proof", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const request = await phone.refreshRequest();
    const replay = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ refreshToken: phone.tokens!.refreshToken }) });
    expect((await read(await district.app.fetch(request))).status).toBe(200);
    expect(await read(await district.app.fetch(replay))).toMatchObject({ status: 401, body: { reason: "proof-replayed" } });
  });
});

describe("revocation", () => {
  it("takes effect on the next request, and deactivating a principal revokes their devices", async () => {
    const district = await deviceDistrict({ authority: "local" });
    const elena = await pairedPhone(district, NF.elena);
    expect((await read(await district.app.fetch(await elena.request("GET", "/api/m/me")))).status).toBe(200);
    await district.ok(district.tokenFor(NF.admin), "admin.setPrincipalStatus", { params: { principalId: NF.elena }, body: { status: "inactive" } });
    expect(await read(await district.app.fetch(await elena.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    expect(await district.app.devices.store.get(elena.tokens!.deviceId)).toMatchObject({ status: "revoked", revokedReason: "principal-inactive", revokedBy: NF.admin });
    // Coming back does not bring the old phone back.
    await district.ok(district.tokenFor(NF.admin), "admin.setPrincipalStatus", { params: { principalId: NF.elena }, body: { status: "active" } });
    expect(await read(await district.app.fetch(await elena.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });

  it("revokes a device whose principal was deactivated some other way, on its next request", async () => {
    const district = await deviceDistrict();
    const elena = await pairedPhone(district, NF.elena);
    const { snapshot, version } = await district.app.stores.directory.load();
    await district.app.stores.directory.commit({ ...snapshot, principals: snapshot.principals.map((p) => p.id === NF.elena ? { ...p, status: "inactive" } : p) }, version);
    expect(await read(await district.app.fetch(await elena.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    expect(await district.app.devices.store.get(elena.tokens!.deviceId)).toMatchObject({ status: "revoked", revokedReason: "principal-inactive", revokedBy: "system" });
  });

  it("is available to administrators and operators as a function", async () => {
    const district = await deviceDistrict();
    const one = await pairedPhone(district, NF.amara);
    const two = await pairedPhone(district, NF.amara);
    expect(await district.app.devices.revoke(one.tokens!.deviceId, { by: NF.admin, reason: "admin-revoked" })).toBe(true);
    expect(await district.app.devices.revoke(one.tokens!.deviceId, { by: NF.admin, reason: "admin-revoked" })).toBe(false);
    expect(await district.app.devices.revokePrincipal(NF.amara as never, { by: "system", reason: "app-version" })).toBe(1);
    expect(await read(await district.app.fetch(await two.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });
});

describe("Your devices", () => {
  it("lists, revokes and signs out everywhere over the web session, for the caller's own devices only", async () => {
    const district = await deviceDistrict();
    const amara = district.tokenFor(NF.amara);
    const phone = await pairedPhone(district, NF.amara);
    const tablet = await pairedPhone(district, NF.amara);
    const elenas = await pairedPhone(district, NF.elena);

    const listed = await district.ok(amara, "me.devices");
    expect(listed.devices.map((d) => d.id)).toStrictEqual([tablet.tokens!.deviceId, phone.tokens!.deviceId]);
    expect(listed.devices[0]).not.toHaveProperty("publicJwk");
    expect(listed.devices[0]).not.toHaveProperty("pushToken");

    expectError(await district.call(amara, "me.revokeDevice", { params: { deviceId: elenas.tokens!.deviceId } }), 404, "not-found");
    expect((await read(await district.app.fetch(await elenas.request("GET", "/api/m/me")))).status).toBe(200);

    const revoked = await district.ok(amara, "me.revokeDevice", { params: { deviceId: phone.tokens!.deviceId } });
    expect(revoked).toMatchObject({ status: "revoked", revokedReason: "signed-out" });
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });

    expect(await district.ok(amara, "me.revokeAllDevices")).toStrictEqual({ revoked: 1 });
    expect(await read(await district.app.fetch(await tablet.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    expect((await read(await district.app.fetch(await elenas.request("GET", "/api/m/me")))).status).toBe(200);
  });

  it("is reachable from the phone itself, which can sign itself out but not another person's device", async () => {
    const district = await deviceDistrict();
    const phone = await pairedPhone(district, NF.amara);
    const elenas = await pairedPhone(district, NF.elena);
    const listed = await read(await district.app.fetch(await phone.request("GET", "/api/m/me/devices")));
    expect(listed.status).toBe(200);
    expect(ROUTES["me.devices"].response.parse(listed.body).devices.map((d) => d.id)).toStrictEqual([phone.tokens!.deviceId]);

    const other = await read(await district.app.fetch(await phone.request("POST", `/api/m/me/devices/${elenas.tokens!.deviceId}/revoke`)));
    expect(other).toMatchObject({ status: 404, body: { code: "not-found" } });
    const self = await read(await district.app.fetch(await phone.request("POST", `/api/m/me/devices/${phone.tokens!.deviceId}/revoke`)));
    expect(self).toMatchObject({ status: 200, body: { status: "revoked" } });
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
  });
});
