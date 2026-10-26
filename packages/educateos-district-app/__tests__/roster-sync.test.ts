// SCHO-203: the district runs its Clever roster sync on a schedule, over the live directory, and an
// administrator sees its health, runs one now, and approves a held removal.
import { DistrictDirectorySnapshot, PrincipalId } from "@educateos/contracts";
import { CEDARVALLEY, demoDistrict, districtSeed } from "@educateos/fixtures";
import { clever, oneroster } from "@educateos/integrations";
import { CleverDataFake } from "@educateos/provider-fakes";
import { describe, expect, it } from "vitest";
import type { RosterSourceFactory } from "../src/index.ts";
import { bootDistrict, expectError } from "./support.ts";

const D = CEDARVALLEY.district.id;
const IDP = CEDARVALLEY.district.trustedIssuers[0]!;
const ADMIN = PrincipalId.parse("prn_cv-district-admin");
const SERVICE = PrincipalId.parse("prn_cv-roster-service");
const TEACHER = PrincipalId.parse("prn_cv-local-teacher");
const START = Date.parse("2026-10-20T15:00:00Z");

/** Cedar Valley before its roster: the district, its administrator, a roster service and one local teacher. */
const BEFORE_ROSTER = DistrictDirectorySnapshot.parse({
  district: CEDARVALLEY.district,
  schools: [],
  terms: [],
  courses: [],
  offerings: [],
  principals: [
    CEDARVALLEY.principals.find((p) => p.id === ADMIN)!,
    { id: SERVICE, districtId: D, kind: "service", status: "active", displayName: "Roster sync", externalIdentities: [{ districtId: D, issuer: IDP, subject: "svc-roster-sync" }] },
    { id: TEACHER, districtId: D, kind: "staff", status: "active", displayName: "Local Teacher", externalIdentities: [{ districtId: D, issuer: IDP, subject: "local-teacher" }] },
  ],
  enrollments: [],
  roleAssignments: [
    { principalId: ADMIN, role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: SERVICE, role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
  ],
});

function config(fake: CleverDataFake): Record<string, unknown> {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: D,
    profile: "us-k12-conservative",
    identity: { provider: "cloudflare-access" },
    rostering: {
      provider: "clever",
      mode: "apply-automatically",
      identityMapping: { issuer: IDP, subject: clever.CLEVER_SUBJECT_FIELD },
      schedule: { deltaEveryMinutes: 15, completeEveryHours: 24 },
      clever: { districtId: fake.districtId },
    },
    modules: { "core-learning": "enabled" },
    rollout: { target: "all-active-offerings", requiresAdminActivation: false },
    policies: { ai: { spending: "capped", promptsInGatewayLogs: false } },
  };
}

async function setup(options: { service?: boolean; configure?: boolean; authority?: "clever" | "oneroster" } = {}) {
  const clock = { ms: START };
  const fake = new CleverDataFake({ seed: districtSeed(demoDistrict("cedarvalley")), now: () => clock.ms });
  const interference = { before: undefined as undefined | (() => Promise<void>) };
  const rosterSource: RosterSourceFactory = (rostering) => {
    if (rostering.provider !== "clever" || rostering.clever === undefined) return { reason: "not a Clever roster" };
    const source = clever.cleverRosterSource(new clever.CleverDataClient({ connection: rostering.clever, token: fake.districtToken, fetch: fake.fetch, sleep: async () => {} }));
    return {
      source: {
        ...source,
        read: async (request: oneroster.RosterReadRequest) => {
          const batch = await source.read(request);
          await interference.before?.();
          return batch;
        },
      },
    };
  };
  const district = await bootDistrict(BEFORE_ROSTER, {
    standards: [],
    authority: options.authority ?? "clever",
    now: () => new Date(clock.ms),
    rosterSource,
    ...(options.service === false ? {} : { rosterServicePrincipalId: SERVICE }),
  });
  const admin = district.tokenFor(ADMIN);
  if (options.configure !== false) await district.ok(admin, "admin.applyConfig", { body: { document: config(fake), acknowledgeApprovals: true } });
  const students = async () => (await district.app.stores.directory.load()).snapshot.principals.filter((p) => p.kind === "student");
  return { district, fake, clock, admin, interference, students };
}

describe("the scheduled Clever roster sync", () => {
  it("syncs the whole roster first, then deltas when they are due, over the live directory", async () => {
    const { district, fake, clock, admin, students } = await setup();
    const first = await district.app.rostering.runScheduledSync();
    expect(first).toMatchObject({ ran: true, run: { mode: "complete", outcome: "succeeded" } });
    expect(await students()).toHaveLength(6);
    // The local principals stay as they were: the roster manages only what it imported.
    expect((await district.app.stores.directory.load()).snapshot.principals.find((p) => p.id === TEACHER)?.status).toBe("active");

    clock.ms += 5 * 60_000;
    expect(await district.app.rostering.runScheduledSync()).toEqual({ ran: false, reason: "not-due" });

    clock.ms += 15 * 60_000;
    fake.removePerson("prn_cv-student-leila");
    const delta = await district.app.rostering.runScheduledSync();
    expect(delta).toMatchObject({ ran: true, run: { mode: "delta", outcome: "succeeded", counts: { principals: { deactivated: 1 } } } });
    expect((await students()).filter((s) => s.status === "active")).toHaveLength(5);

    const status = await district.ok(admin, "admin.rosterSyncStatus");
    expect(status).toMatchObject({ provider: "clever", runnable: true, health: { status: "healthy", consecutiveFailures: 0 } });
    expect(status.runs.map((r) => r.mode)).toEqual(["complete", "delta"]);
  });

  it("does not run without a roster service principal, a schedule or a configuration", async () => {
    const noService = await setup({ service: false });
    expect(await noService.district.app.rostering.runScheduledSync()).toEqual({ ran: false, reason: "no roster service principal is configured" });
    const unconfigured = await setup({ configure: false });
    expect(await unconfigured.district.app.rostering.runScheduledSync()).toEqual({ ran: false, reason: "no configuration revision has been applied" });
    expect(await unconfigured.district.ok(unconfigured.admin, "admin.rosterSyncStatus")).toMatchObject({ provider: "none", runnable: false, runs: [] });
  });

  it("keeps nothing when another change lands on the directory during the sync", async () => {
    const { district, interference, students } = await setup();
    interference.before = async () => {
      const { version, snapshot } = await district.app.stores.directory.load();
      await district.app.stores.directory.commit(snapshot, version);
    };
    const outcome = await district.app.rostering.runScheduledSync();
    expect(outcome).toMatchObject({ ran: true, run: { outcome: "failed", errorCode: "internal-error" } });
    expect(await students()).toHaveLength(0);
    expect(await district.app.stores.rosterSync.load()).toEqual({});
  });

  it("runs one sync at a time: an administrator's run during a scheduled one is refused", async () => {
    const { district, admin, interference, students } = await setup();
    let during: Awaited<ReturnType<typeof district.call>> | undefined;
    interference.before = async () => {
      interference.before = undefined;
      during = await district.call(admin, "admin.runRosterSync", { body: {} });
    };
    expect(await district.app.rostering.runScheduledSync()).toMatchObject({ ran: true, run: { outcome: "succeeded" } });
    expectError(during!, 409, "conflict");
    expect(await students()).toHaveLength(6);
    // Once it finished, the next run goes ahead.
    expect(await district.ok(admin, "admin.runRosterSync", { body: {} })).toMatchObject({ ran: true });
  });

  it("records a run that throws as failed, so the sync's health shows it", async () => {
    const { district, admin, interference } = await setup();
    interference.before = async () => { throw new Error("the provider client broke"); };
    await expect(district.app.rostering.runScheduledSync()).rejects.toThrow("the provider client broke");
    const status = await district.ok(admin, "admin.rosterSyncStatus");
    expect(status.runs).toMatchObject([{ mode: "complete", outcome: "failed", errorCode: "internal-error" }]);
  });

  it("does not run when the roster service principal is not an active district administrator", async () => {
    const { district } = await setup();
    const { version, snapshot } = await district.app.stores.directory.load();
    await district.app.stores.directory.commit({ ...snapshot, roleAssignments: snapshot.roleAssignments.filter((a) => a.principalId !== SERVICE) }, version);
    expect(await district.app.rostering.runScheduledSync()).toEqual({ ran: false, reason: "the roster service principal is not an active district administrator" });
  });

  it("says why it cannot run when the directory is not owned by the roster's provider", async () => {
    const { district, admin } = await setup({ authority: "oneroster" });
    const status = await district.ok(admin, "admin.rosterSyncStatus");
    expect(status).toMatchObject({ provider: "clever", runnable: false });
    expect(status.reason).toContain("the roster does not own the directory");
    expectError(await district.call(admin, "admin.runRosterSync", { body: {} }), 503, "unavailable");
  });
});

describe("an administrator and the roster sync", () => {
  it("is refused to anyone but a district administrator", async () => {
    const { district } = await setup();
    const teacher = district.tokenFor(TEACHER);
    expectError(await district.call(teacher, "admin.runRosterSync", { body: {} }), 403, "forbidden");
    expectError(await district.call(teacher, "admin.rosterSyncStatus"), 403, "forbidden");
    expectError(await district.call(teacher, "admin.approveRosterRemoval", { body: { fingerprint: "0".repeat(64) } }), 403, "forbidden");
  });

  it("sees a held removal in the sync's health, approves exactly it, and the next sync applies it", async () => {
    const { district, fake, clock, admin, students } = await setup();
    await district.ok(admin, "admin.runRosterSync", { body: {} });
    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.5 });

    const held = await district.ok(admin, "admin.runRosterSync", { body: { mode: "delta" } });
    expect(held.run).toMatchObject({ outcome: "failed", errorCode: "removal-held", held: { principals: { deactivated: 3, active: 9 } } });
    expect((await students()).filter((s) => s.status === "active")).toHaveLength(6);
    expect(await district.ok(admin, "admin.rosterSyncStatus")).toMatchObject({ health: { status: "degraded", lastErrorCode: "removal-held" } });

    expectError(await district.call(admin, "admin.approveRosterRemoval", { body: { fingerprint: "0".repeat(64) } }), 409, "conflict");
    const fingerprint = held.run!.held!.fingerprint;
    await district.ok(admin, "admin.approveRosterRemoval", { body: { fingerprint } });
    expect(await district.ok(admin, "admin.rosterSyncStatus")).toMatchObject({ approvedRemoval: fingerprint });

    const applied = await district.ok(admin, "admin.runRosterSync", { body: { mode: "delta" } });
    expect(applied.run).toMatchObject({ outcome: "succeeded", counts: { principals: { deactivated: 3 } } });
    expect((await students()).filter((s) => s.status === "active")).toHaveLength(3);
    // The approval was used up.
    expect(await district.ok(admin, "admin.rosterSyncStatus")).not.toHaveProperty("approvedRemoval");
  });

  it("drops an approval when the next run holds a different removal, and reruns the held run's mode by default", async () => {
    const { district, fake, clock, admin } = await setup();
    await district.ok(admin, "admin.runRosterSync", { body: {} });
    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.5 });
    const held = await district.ok(admin, "admin.runRosterSync", { body: { mode: "delta" } });
    await district.ok(admin, "admin.approveRosterRemoval", { body: { fingerprint: held.run!.held!.fingerprint } });

    clock.ms += 60_000;
    fake.inject({ kind: "large-removal", fraction: 0.75 });
    const again = await district.ok(admin, "admin.runRosterSync", { body: {} });
    expect(again.run).toMatchObject({ mode: "delta", outcome: "failed", errorCode: "removal-held" });
    expect(again.run!.held!.fingerprint).not.toBe(held.run!.held!.fingerprint);
    const status = await district.ok(admin, "admin.rosterSyncStatus");
    expect(status).not.toHaveProperty("approvedRemoval");
    // The rest of the sync record survives: the next delta still has the cursor the first run left.
    expect(await district.app.stores.rosterSync.load()).toHaveProperty("mirror");
  });
});
