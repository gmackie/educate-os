// Point-in-time recovery (SCHO-373). The route's contract over a recording storage: the gate, both
// credentials, the input checks and the restore's order (schedule, answer the undo bookmark, then
// restart). Then the same routes through the Worker against the district's real SQLite object in
// workerd, which hands out the current bookmark but keeps no history, so it refuses both a bookmark
// for a past time and a restore: that refusal
// is what the 2026-11-14 rehearsal recorded (docs/educateos/runbooks/backup-and-restore.md).
import { env, SELF } from "cloudflare:test";
import { importJWK, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import type { VerifiedIdentity } from "@educateos/contracts";
import { MIN_RECOVERY_TOKEN_LENGTH, RECOVERY_WINDOW_MS, serveRecovery, type RecoveryEvent, type RecoveryOptions, type RecoveryStorage } from "../src/recovery.ts";
import { ACCESS_AUDIENCE, ACCESS_ISSUER, RECOVERY_TOKEN } from "./fixtures.ts";

const DISTRICT_ID = NORTHFIELD.district.id;
const OPERATOR: VerifiedIdentity = { issuer: ACCESS_ISSUER, subject: "operator-subject", credential: "person" };
const NOW = new Date("2026-11-14T15:00:00.000Z");

/** A storage that records what recovery asked of it. */
function recordingStorage(): RecoveryStorage & { restores: string[]; times: Date[] } {
  const restores: string[] = [];
  const times: Date[] = [];
  return {
    restores,
    times,
    getCurrentBookmark: async () => "0000002a-00000001-00000000-00000000000000000000000000000000",
    getBookmarkForTime: async (time) => {
      times.push(new Date(time));
      return "00000010-00000001-00000000-00000000000000000000000000000000";
    },
    onNextSessionRestoreBookmark: async (bookmark) => {
      restores.push(bookmark);
      return "0000002b-00000001-00000000-00000000000000000000000000000000";
    },
  };
}

function harness(overrides: Partial<RecoveryOptions> = {}) {
  const storage = recordingStorage();
  const events: RecoveryEvent[] = [];
  const order: string[] = [];
  const options: RecoveryOptions = {
    districtId: DISTRICT_ID,
    token: RECOVERY_TOKEN,
    verifyAccess: async (request) => (request.headers.get("cf-access-jwt-assertion") === "signed" ? OPERATOR : undefined),
    storage: { ...storage, onNextSessionRestoreBookmark: async (b) => (order.push("restore"), storage.onNextSessionRestoreBookmark(b)) },
    restart: () => order.push("restart"),
    onEvent: (event) => events.push(event),
    now: () => NOW,
    ...overrides,
  };
  const call = async (method: "GET" | "POST", path: string, init: { token?: string | null; access?: boolean; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    const token = init.token === undefined ? RECOVERY_TOKEN : init.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (init.access !== false) headers["cf-access-jwt-assertion"] = "signed";
    const request = new Request(`https://district.example/api/recovery/${path}`, {
      method, headers, ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    });
    const response = await serveRecovery(request, options);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { storage, events, order, call };
}

describe("the recovery routes", () => {
  it("are 404 without a long enough RECOVERY_TOKEN", async () => {
    for (const token of [undefined, "", "x".repeat(MIN_RECOVERY_TOKEN_LENGTH - 1), ` ${"x".repeat(MIN_RECOVERY_TOKEN_LENGTH - 1)}\n`]) {
      const { call, storage } = harness({ token });
      expect((await call("GET", "bookmark", { token: token ?? "anything" })).status).toBe(404);
      expect((await call("POST", "restore", { token: token ?? "anything", body: { districtId: DISTRICT_ID, bookmark: "00" } })).status).toBe(404);
      expect(storage.restores).toStrictEqual([]);
    }
  });

  it("need both the token and an Access sign-in", async () => {
    const { call, storage, events } = harness();
    expect((await call("GET", "bookmark", { token: null })).status).toBe(401);
    expect((await call("GET", "bookmark", { token: `${RECOVERY_TOKEN}x` })).status).toBe(401);
    expect((await call("GET", "bookmark", { access: false })).status).toBe(401);
    expect((await call("POST", "restore", { access: false, body: { districtId: DISTRICT_ID, bookmark: "00" } })).status).toBe(401);
    expect(storage.restores).toStrictEqual([]);
    expect(events.every((e) => e.event === "district.recovery.refused" && e.status === 401)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(RECOVERY_TOKEN);
  });

  it("read the current bookmark and the bookmark for a time in the window", async () => {
    const { call, storage, events } = harness();
    expect(await call("GET", "bookmark")).toStrictEqual({
      status: 200,
      body: { districtId: DISTRICT_ID, current: "0000002a-00000001-00000000-00000000000000000000000000000000" },
    });
    const at = "2026-11-14T14:00:00.000Z";
    const read = await call("GET", `bookmark?at=${encodeURIComponent(at)}`);
    expect(read).toMatchObject({ status: 200, body: { at: { requested: at, bookmark: "00000010-00000001-00000000-00000000000000000000000000000000" } } });
    expect((await call("GET", `bookmark?at=${Date.parse(at)}`)).status).toBe(200);
    expect(storage.times.map((t) => t.toISOString())).toStrictEqual([at, at]);
    expect(events.at(-1)).toMatchObject({ event: "district.recovery.bookmark", operatorSubject: "operator-subject" });
  });

  it("refuse a time that is unreadable, in the future or older than 30 days", async () => {
    const { call, storage } = harness();
    for (const at of ["yesterday", "2026-11-14T16:00:00Z", new Date(NOW.getTime() - RECOVERY_WINDOW_MS - 60_000).toISOString()]) {
      expect((await call("GET", `bookmark?at=${encodeURIComponent(at)}`)).status).toBe(400);
    }
    expect(storage.times).toStrictEqual([]);
  });

  it("schedule a restore, answer the bookmark that undoes it, then restart", async () => {
    const { call, storage, events, order } = harness();
    const bookmark = "00000010-00000001-00000000-00000000000000000000000000000000";
    expect(await call("POST", "restore", { body: { districtId: DISTRICT_ID, bookmark } })).toStrictEqual({
      status: 202,
      body: { districtId: DISTRICT_ID, restoredTo: bookmark, undoBookmark: "0000002b-00000001-00000000-00000000000000000000000000000000" },
    });
    expect(storage.restores).toStrictEqual([bookmark]);
    expect(order).toStrictEqual(["restore", "restart"]);
    expect(events.at(-1)).toMatchObject({ event: "district.recovery.restore", bookmark, undoBookmark: "0000002b-00000001-00000000-00000000000000000000000000000000" });
  });

  it("refuse a restore of another district, a malformed body or bookmark, and restart nothing", async () => {
    const { call, storage, order } = harness();
    expect((await call("POST", "restore", { body: { districtId: "dst_riverbend", bookmark: "00" } })).status).toBe(409);
    expect((await call("POST", "restore", { body: { districtId: DISTRICT_ID, bookmark: "not a bookmark" } })).status).toBe(400);
    expect((await call("POST", "restore", { body: { districtId: DISTRICT_ID } })).status).toBe(400);
    expect((await call("POST", "restore", { body: "{" })).status).toBe(400);
    expect((await call("GET", "restore")).status).toBe(404);
    expect(storage.restores).toStrictEqual([]);
    expect(order).toStrictEqual([]);
  });

  it("restart nothing when the platform refuses the restore", async () => {
    const failing: RecoveryStorage = { ...recordingStorage(), onNextSessionRestoreBookmark: async () => { throw new Error("bookmark is older than the retention window"); } };
    const { call, order, events } = harness({ storage: failing });
    expect(await call("POST", "restore", { body: { districtId: DISTRICT_ID, bookmark: "00" } })).toMatchObject({ status: 502, body: { code: "recovery-failed" } });
    expect(order).toStrictEqual([]);
    expect(events.at(-1)).toMatchObject({ event: "district.recovery.failed" });
  });
});

async function accessAssertion(): Promise<string> {
  const subject = NORTHFIELD.principals.find((p) => p.id === "prn_nf-district-admin")!.externalIdentities[0]!.subject;
  const key = await importJWK(JSON.parse(env.TEST_ACCESS_PRIVATE_JWK) as JWK, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ACCESS_ISSUER, aud: ACCESS_AUDIENCE, sub: subject, iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "RS256", kid: "test-access-key" })
    .sign(key);
}

/** Calls the Worker with the token and, unless told otherwise, a signed Access assertion. */
async function viaWorker(method: "GET" | "POST", path: string, init: { body?: unknown; access?: boolean } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${RECOVERY_TOKEN}` };
  if (init.access !== false) headers["cf-access-jwt-assertion"] = await accessAssertion();
  const response = await SELF.fetch(`https://district.example/api/recovery/${path}`, {
    method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("the recovery routes through the Worker, over workerd's local SQLite", () => {
  it("verify the Access assertion themselves", async () => {
    expect((await viaWorker("GET", "bookmark", { access: false })).status).toBe(401);
  });

  it("read the current bookmark, and report that local storage keeps no history to look up or restore", async () => {
    const before = await viaWorker("GET", "bookmark");
    expect(before.status).toBe(200);
    const current = before.body.current as string;
    expect(current).toMatch(/^[0-9a-f]+(-[0-9a-f]+)+$/);

    // The district app starts on its first request and writes its stores, so the bookmark can only move on.
    const write = await SELF.fetch("https://district.example/api/admin/health", { headers: { "cf-access-jwt-assertion": await accessAssertion() } });
    await write.arrayBuffer();
    const after = await viaWorker("GET", "bookmark");
    expect(after.body.current as string >= current).toBe(true);
    // Local workerd has no history, so neither a bookmark for a past time nor a restore is available.
    expect(await viaWorker("GET", `bookmark?at=${Date.now() - 60_000}`)).toMatchObject({ status: 501, body: { code: "recovery-unavailable" } });

    const restore = await viaWorker("POST", "restore", { body: { districtId: DISTRICT_ID, bookmark: current } });
    expect(restore).toMatchObject({ status: 501, body: { code: "recovery-unavailable" } });
    // Nothing was scheduled, so the district still serves.
    const health = await SELF.fetch("https://district.example/api/admin/health", { headers: { "cf-access-jwt-assertion": await accessAssertion() } });
    expect(health.status).toBe(200);
    await health.arrayBuffer();
  });
});
