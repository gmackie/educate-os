// The district's signed operations API (SCHO-263), end to end: an admin edition's key, made with the
// admin's own signing code, enrolled through district /admin → Operations, then every /api/ops route
// called signed, each answer parsed with the protocol's schema, and each request found in the
// district's ops audit log. The refusal matrix for every route is in devices.test.ts.
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { OPS_RESPONSES, type OpsRouteName } from "@educateos/fleet/ops";
import { InMemoryOpsStore, type CloudflareAnalyticsReport, type OpsAnalyticsSource } from "../src/index.ts";
import { bootDistrict, expectError, NF, type TestDistrict } from "./support.ts";
import { read, TestPhone } from "./device-support.ts";
import { adminKey, ALL_SCOPES, ADMIN_ORIGIN, enrolledKey, OPERATOR, opsRequest } from "./ops-support.ts";

const SECRET = "test-device-token-secret-0123456789-abcdef";
const START = Date.parse("2026-10-28T12:00:00.000Z");

const CLOUDFLARE_REPORT: CloudflareAnalyticsReport = {
  range: "24h",
  generatedAt: "2026-10-28T12:00:00.000Z",
  sampled: true,
  workers: [{ script: "northfield-district", invocations: 1200, errors: 4, cpuTimeP50Ms: 1.2, cpuTimeP99Ms: 18 }],
  http: { requests: 1200, byStatus: [] },
  series: [{ at: "2026-10-28T11:00:00.000Z", requests: 50, errors: 0 }],
  durableObjects: { requests: 900, storageBytes: 1_000_000 },
  storage: { r2Bytes: 0, d1Bytes: 0 },
  signIns: { byMethod: [{ method: "google", count: 12 }], failures: 1 },
};

type OpsDistrict = TestDistrict & { clock: { now: number } };

/** A district with a moving clock, device sign-in, and optionally an analytics source. */
async function opsDistrict(options: { analytics?: OpsAnalyticsSource } = {}): Promise<OpsDistrict> {
  const clock = { now: START };
  const district = await bootDistrict(NORTHFIELD, {
    now: () => new Date(clock.now),
    deviceTokenSecret: SECRET,
    // A district that authors its own people.
    authority: "local",
    release: { version: "r000042", commit: "abcdef1", channel: "stable" },
    ...(options.analytics === undefined ? {} : { opsAnalytics: options.analytics }),
  });
  return Object.assign(district, { clock });
}

async function phoneFor(district: OpsDistrict, principalId: string): Promise<TestPhone> {
  const phone = await TestPhone.create(() => district.clock.now);
  phone.tokens = await district.app.devices.registerDevice(principalId as never, phone.registration());
  return phone;
}

/** Sends a signed ops request and parses its answer with the protocol's schema when it succeeded. */
async function ops(
  district: OpsDistrict,
  identity: Awaited<ReturnType<typeof enrolledKey>>,
  method: string,
  path: string,
  route: OpsRouteName,
  body?: unknown,
) {
  const result = await read(await district.app.fetch(await opsRequest(identity, district.clock, method, path, body === undefined ? {} : { body })));
  if (result.status === 200) OPS_RESPONSES[route].parse(result.body);
  return result;
}

describe("enrolling an admin from district /admin → Operations", () => {
  it("accepts the admin's registration as it is, with the scopes the administrator grants", async () => {
    const district = await opsDistrict();
    const { registration } = await adminKey();
    const admin = district.tokenFor(NF.admin);
    const key = await district.ok(admin, "admin.enrollOpsKey", { body: { registration, scopes: ["health", "directory:read"], label: "EducateOS hosted admin" } });
    expect(key).toMatchObject({
      keyId: registration.keyId,
      label: "EducateOS hosted admin",
      adminOrigin: ADMIN_ORIGIN,
      scopes: ["health", "directory:read"],
      requestedScopes: ALL_SCOPES,
      enrolledBy: { principalId: NF.admin, displayName: "Avery Admin" },
      status: "enrolled",
    });
    expect((await district.ok(admin, "admin.opsKeys")).keys.map((k) => k.keyId)).toStrictEqual([registration.keyId]);
    // Without a label, the admin's host names it.
    const second = await adminKey();
    expect((await district.ok(admin, "admin.enrollOpsKey", { body: { registration: second.registration, scopes: ["health"] } })).label).toBe("admin.educateos.io");
  });

  it("refuses a registration whose key ID is not its key's, a scope it did not ask for, and a key enrolled twice", async () => {
    const district = await opsDistrict();
    const admin = district.tokenFor(NF.admin);
    const a = await adminKey(["health"]);
    const b = await adminKey();
    expectError(await district.call(admin, "admin.enrollOpsKey", { body: { registration: { ...a.registration, publicKey: b.registration.publicKey }, scopes: ["health"] } }), 400, "validation-failed");
    expectError(await district.call(admin, "admin.enrollOpsKey", { body: { registration: a.registration, scopes: ["health", "devices"] } }), 400, "validation-failed");
    expectError(await district.call(admin, "admin.enrollOpsKey", { body: { registration: { ...a.registration, extra: true } as never, scopes: ["health"] } }), 400, "validation-failed");
    await district.ok(admin, "admin.enrollOpsKey", { body: { registration: a.registration, scopes: ["health"] } });
    expectError(await district.call(admin, "admin.enrollOpsKey", { body: { registration: a.registration, scopes: ["health"] } }), 409, "conflict");
  });

  it("is a district administrator's alone: a school administrator, a teacher and a student are refused", async () => {
    const district = await opsDistrict();
    const { registration } = await adminKey();
    for (const someone of ["prn_nf-principal-high", NF.rivera, NF.amara]) {
      const token = district.tokenFor(someone);
      expect((await district.call(token, "admin.opsKeys")).status).toBe(403);
      expect((await district.call(token, "admin.enrollOpsKey", { body: { registration, scopes: ["health"] } })).status).toBe(403);
      expect((await district.call(token, "admin.opsAudit")).status).toBe(403);
    }
    expect(await district.app.stores.ops.listKeys()).toStrictEqual([]);
  });

  it("drops a scope or removes the admin at any time, refusing its next request", async () => {
    const district = await opsDistrict();
    const admin = district.tokenFor(NF.admin);
    const identity = await enrolledKey(district, NF.admin);
    expect((await ops(district, identity, "GET", "/api/ops/devices", "devices.list")).status).toBe(200);

    const narrowed = await district.ok(admin, "admin.setOpsKeyScopes", { params: { keyId: identity.keyId }, body: { scopes: ["health"] } });
    expect(narrowed.scopes).toStrictEqual(["health"]);
    expect(await ops(district, identity, "GET", "/api/ops/devices", "devices.list")).toMatchObject({ status: 403, body: { reason: "scope-denied" } });
    // No more than it asked for.
    const small = await adminKey(["health"]);
    await district.ok(admin, "admin.enrollOpsKey", { body: { registration: small.registration, scopes: ["health"] } });
    expectError(await district.call(admin, "admin.setOpsKeyScopes", { params: { keyId: small.identity.keyId }, body: { scopes: ["devices"] } }), 400, "validation-failed");

    const removed = await district.ok(admin, "admin.removeOpsKey", { params: { keyId: identity.keyId } });
    expect(removed).toMatchObject({ status: "removed", removedAt: "2026-10-28T12:00:00.000Z" });
    expect(await ops(district, identity, "GET", "/api/ops/health", "health")).toMatchObject({ status: 401, body: { reason: "unknown-key" } });
    expectError(await district.call(admin, "admin.removeOpsKey", { params: { keyId: identity.keyId } }), 404, "not-found");
    expectError(await district.call(admin, "admin.setOpsKeyScopes", { params: { keyId: identity.keyId }, body: { scopes: ["health"] } }), 404, "not-found");
    // The district keeps working without it.
    expect((await district.call(district.tokenFor(NF.amara), "me.devices")).status).toBe(200);
  });
});

describe("the ops API, called by an enrolled admin", () => {
  it("answers every route to the protocol's schema and records each request in the district's audit log", async () => {
    const district = await opsDistrict({ analytics: { report: async () => CLOUDFLARE_REPORT } });
    const identity = await enrolledKey(district, NF.admin);
    const phone = await phoneFor(district, NF.elena);

    const health = await ops(district, identity, "GET", "/api/ops/health", "health");
    expect(health.body).toMatchObject({ status: "ok", releaseVersion: "r000042", commit: "abcdef1", checkedAt: "2026-10-28T12:00:00.000Z" });
    expect((health.body.components as { name: string; detail: string }[]).find((c) => c.name === "devices")?.detail).toBe("1 active devices");
    expect(await ops(district, identity, "GET", "/api/ops/releases", "releases")).toMatchObject({ status: 200, body: { current: { version: "r000042" }, channel: "stable", available: [] } });

    const analytics = await ops(district, identity, "GET", "/api/ops/analytics?range=24h", "analytics");
    expect(analytics.status).toBe(200);
    expect(analytics.body).toMatchObject({ workers: CLOUDFLARE_REPORT.workers, ai: { requests: 0, ledgerCostUsdNanos: 0 } });
    expect((await ops(district, identity, "GET", "/api/ops/analytics?range=1y", "analytics")).status).toBe(400);

    const page = await ops(district, identity, "GET", "/api/ops/directory?query=okafor", "directory.list");
    expect((page.body.entries as { principal: string }[]).map((e) => e.principal)).toStrictEqual(["prn_nf-student-amara", "prn_nf-student-chidi"]);
    const admins = await ops(district, identity, "GET", "/api/ops/directory?role=admin", "directory.list");
    expect(admins.body.entries).toStrictEqual([expect.objectContaining({ principal: NF.admin, roles: ["staff", "admin"] })]);
    const detail = await ops(district, identity, "GET", `/api/ops/directory/${NF.elena}`, "directory.get");
    expect(detail.body).toMatchObject({ entry: { principal: NF.elena, displayName: "Elena Sato", status: "active", rostered: false }, deviceCount: 1 });
    expect((await ops(district, identity, "GET", "/api/ops/directory/prn_nobody", "directory.get")).status).toBe(404);

    const devices = await ops(district, identity, "GET", `/api/ops/devices?principal=${NF.elena}`, "devices.list");
    expect(devices.body.devices).toStrictEqual([
      expect.objectContaining({ id: phone.tokens!.deviceId, ownerName: "Elena Sato", ownerRole: "student", platform: "ios", appVersion: "1.4.0", status: "active" }),
    ]);

    const revoked = await ops(district, identity, "POST", `/api/ops/devices/${phone.tokens!.deviceId}/revoke`, "devices.revoke", { reason: "lost" });
    expect(revoked.body).toMatchObject({ applied: true, auditId: expect.stringMatching(/^opa_/) });
    expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    expect((await ops(district, identity, "POST", `/api/ops/devices/${phone.tokens!.deviceId}/revoke`, "devices.revoke")).body.applied).toBe(false);

    const audit = await district.ok(district.tokenFor(NF.admin), "admin.opsAudit");
    expect(audit.entries.map((e) => `${e.route} ${e.result}`).toReversed()).toStrictEqual([
      "health ok",
      "releases ok",
      "analytics ok",
      "analytics error:validation-failed",
      "directory.list ok",
      "directory.list ok",
      "directory.get ok",
      "directory.get error:not-found",
      "devices.list ok",
      "devices.revoke applied",
      "devices.revoke unchanged",
    ]);
    expect(audit.entries.every((e) => e.operator === OPERATOR && e.keyId === identity.keyId && e.label === "admin.educateos.io")).toBe(true);
    expect(audit.entries.find((e) => e.id === revoked.body.auditId)).toMatchObject({ route: "devices.revoke", result: "applied", target: phone.tokens!.deviceId });
  });

  it("suspends a person: inactive in the directory and every phone signed out; restore brings them back, not their phones", async () => {
    const district = await opsDistrict();
    const identity = await enrolledKey(district, NF.admin);
    const phones = [await phoneFor(district, NF.amara), await phoneFor(district, NF.amara)];

    const suspended = await ops(district, identity, "POST", `/api/ops/directory/${NF.amara}/suspend`, "directory.action", { reason: "left the district" });
    expect(suspended.body).toMatchObject({ applied: true });
    for (const phone of phones) {
      expect(await read(await district.app.fetch(await phone.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });
    }
    expect((await district.app.devices.store.list(NF.amara as never)).map((d) => [d.status, d.revokedReason, d.revokedBy]))
      .toStrictEqual(phones.map(() => ["revoked", "principal-inactive", `ops:${identity.keyId}`]));
    // An inactive principal can't pair a new phone either.
    await expect(phoneFor(district, NF.amara)).rejects.toThrow(/not an active principal/);
    expect((await ops(district, identity, "GET", `/api/ops/directory/${NF.amara}`, "directory.get")).body).toMatchObject({ entry: { status: "suspended" }, deviceCount: 0 });
    expect((await ops(district, identity, "GET", "/api/ops/directory?status=suspended", "directory.list")).body.entries).toHaveLength(1);
    expect((await ops(district, identity, "POST", `/api/ops/directory/${NF.amara}/suspend`, "directory.action", {})).body.applied).toBe(false);

    expect((await ops(district, identity, "POST", `/api/ops/directory/${NF.amara}/restore`, "directory.action")).body.applied).toBe(true);
    await phoneFor(district, NF.amara);
    expect(await read(await district.app.fetch(await phones[0]!.request("GET", "/api/m/me")))).toMatchObject({ status: 401, body: { reason: "device-revoked" } });

    const audit = (await district.ok(district.tokenFor(NF.admin), "admin.opsAudit")).entries.toReversed();
    expect(audit.filter((e) => e.route === "directory.action").map((e) => [e.target, e.result])).toStrictEqual([
      [`${NF.amara}/suspend`, "applied"],
      [`${NF.amara}/suspend`, "unchanged"],
      [`${NF.amara}/restore`, "applied"],
    ]);
  });

  it("won't suspend or demote the district's last administrator", async () => {
    const district = await opsDistrict();
    const identity = await enrolledKey(district, NF.admin);
    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.admin}/suspend`, "directory.action")).toMatchObject({ status: 409, body: { code: "conflict" } });
    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.admin}/roles`, "directory.action", { grant: [], revoke: ["admin"] })).toMatchObject({ status: 409 });
  });

  it("signs a person out everywhere, grants and revokes administration, and answers 501 for what the district has no concept of", async () => {
    const district = await opsDistrict();
    const identity = await enrolledKey(district, NF.admin);
    await phoneFor(district, NF.rivera);
    expect((await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/sign-out-everywhere`, "directory.action")).body.applied).toBe(true);
    expect((await district.app.devices.store.list(NF.rivera as never)).every((d) => d.status === "revoked" && d.revokedReason === "admin-revoked")).toBe(true);

    expect((await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/roles`, "directory.action", { grant: ["admin"], revoke: [] })).body.applied).toBe(true);
    expect((await ops(district, identity, "GET", `/api/ops/directory/${NF.rivera}`, "directory.get")).body).toMatchObject({ entry: { roles: ["staff", "admin"] } });
    expect((await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/roles`, "directory.action", { grant: [], revoke: ["admin"] })).body.applied).toBe(true);
    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.amara}/roles`, "directory.action", { grant: ["admin"], revoke: [] })).toMatchObject({ status: 409 });

    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/roles`, "directory.action", { grant: ["staff"], revoke: [] }))
      .toMatchObject({ status: 501, body: { code: "unavailable", reason: "not-supported" } });
    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/ai-access`, "directory.action", { level: "extended" }))
      .toMatchObject({ status: 501, body: { reason: "not-supported" } });
    expect(await ops(district, identity, "POST", `/api/ops/directory/${NF.rivera}/ai-access`, "directory.action", { level: "everything" }))
      .toMatchObject({ status: 400 });
  });

  it("revokes every phone below an app version, on one platform or both", async () => {
    const district = await opsDistrict();
    const identity = await enrolledKey(district, NF.admin);
    const register = async (principalId: string, platform: "ios" | "android", appVersion: string) => {
      const phone = await TestPhone.create(() => district.clock.now);
      return (await district.app.devices.registerDevice(principalId as never, { ...phone.registration(), platform, appVersion })).deviceId;
    };
    const oldIos = await register(NF.amara, "ios", "1.3.9");
    const newIos = await register(NF.elena, "ios", "1.4.0");
    const oldAndroid = await register(NF.rivera, "android", "1.2.0");
    expect((await ops(district, identity, "POST", "/api/ops/devices/revoke-below-version", "devices.revoke-below-version", { minimumVersion: "1.4.0", platform: "ios" })).body)
      .toMatchObject({ revoked: 1 });
    const status = async (id: string) => (await district.app.devices.store.get(id as never))!.status;
    expect([await status(oldIos), await status(newIos), await status(oldAndroid)]).toStrictEqual(["revoked", "active", "active"]);
    expect((await ops(district, identity, "POST", "/api/ops/devices/revoke-below-version", "devices.revoke-below-version", { minimumVersion: "2.0.0" })).body).toMatchObject({ revoked: 2 });
    expect((await ops(district, identity, "POST", "/api/ops/devices/revoke-below-version", "devices.revoke-below-version", { minimumVersion: "2" })).status).toBe(400);
  });

  it("answers analytics 501 analytics-not-configured without a token, and 502 when Cloudflare can't be read", async () => {
    const bare = await opsDistrict();
    const key = await enrolledKey(bare, NF.admin);
    expect(await ops(bare, key, "GET", "/api/ops/analytics?range=7d", "analytics")).toMatchObject({ status: 501, body: { code: "unavailable", reason: "analytics-not-configured" } });

    const broken = await opsDistrict({
      analytics: {
        report: async () => {
          throw new Error("cloudflare is down");
        },
      },
    });
    const other = await enrolledKey(broken, NF.admin);
    expect(await ops(broken, other, "GET", "/api/ops/analytics?range=7d", "analytics")).toMatchObject({ status: 502, body: { reason: "analytics-unavailable" } });
  });

  it("records a validly signed request refused for its scope, its route or a replay, and nothing for one that never verified", async () => {
    const district = await opsDistrict();
    const identity = await enrolledKey(district, NF.admin, ["health"]);
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
    await read(await district.app.fetch(await opsRequest(identity, district.clock, "GET", "/api/ops/devices", { nonce })));
    await read(await district.app.fetch(await opsRequest(identity, district.clock, "GET", "/api/ops/devices", { nonce })));
    await read(await district.app.fetch(await opsRequest(identity, district.clock, "GET", "/api/ops/nope")));
    await read(await district.app.fetch(await opsRequest(identity, district.clock, "GET", "/api/ops/health", { at: START - 120_000 })));
    await read(await district.app.fetch(new Request("https://district.example/api/ops/health", { headers: { "educateos-ops-operator": "mallory" } })));
    const audit = (await district.ok(district.tokenFor(NF.admin), "admin.opsAudit")).entries.toReversed();
    expect(audit.map((e) => [e.route, e.result])).toStrictEqual([
      ["devices.list", "refused:scope-denied"],
      ["devices.list", "refused:replayed"],
      ["unknown-route", "refused:unknown-route"],
    ]);
  });
});

describe("the in-memory ops store", () => {
  it("claims a nonce once per key, and forgets it once it expires", async () => {
    const store = new InMemoryOpsStore();
    expect(await store.claimNonce("k1", "n", 1000, 0)).toBe(true);
    expect(await store.claimNonce("k1", "n", 1000, 500)).toBe(false);
    expect(await store.claimNonce("k2", "n", 1000, 500)).toBe(true);
    expect(await store.claimNonce("k1", "n", 3000, 2000)).toBe(true);
    expect(store.nonceCount).toBe(1);
  });
});
