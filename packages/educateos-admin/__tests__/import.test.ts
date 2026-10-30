// The import of educateos.io's operators, installations and slug reservations (SCHO-263): a dry run
// writes nothing, a real run maps each installation onto a workspace, a second run changes nothing,
// and nothing about the districts' people lands in D1.
import { env } from "cloudflare:test";
import type { ControlPlaneExport } from "@educateos/control-plane/export";
import { describe, expect, it } from "vitest";
import type { AuditPage, ImportReport, InstallationsResponse, Workspace, WorkspaceDetail } from "../src/shared/api.ts";
import type { ControlPlaneSource } from "../src/worker/import.ts";
import { adminDeps, assertion, call, manualClock } from "./support.ts";

let runs = 0;

/** A control-plane account ID, `acct_` and 128 random bits, as the control plane makes them. */
const accountId = () =>
  `acct_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}` as ControlPlaneExport["operators"][number]["accountId"];

/** A control-plane export with two operators, two installations and two reservations, all unique to this call. */
function exportFixture() {
  const n = `${Date.now().toString(36)}${runs++}`;
  const alice = { subject: `cp-alice-${n}`, accountId: accountId(), email: `alice-${n}@installer.example`, firstSeenAt: "2026-10-20T09:00:00.000Z", lastSeenAt: "2026-10-27T09:00:00.000Z" };
  const bob = { ...alice, subject: `cp-bob-${n}`, accountId: accountId(), email: `bob-${n}@installer.example` };
  const install = (who: typeof alice, slug: string) => ({
    operatorSubject: who.subject,
    installation: { instanceId: `ins_${slug}`, slug, hostname: `${slug}.educateos.io`, accountId: "c".repeat(32), releaseVersion: "0.1.0", installedAt: "2026-10-26T14:00:00.000Z" },
  });
  const north = `north${n}`.slice(0, 20);
  const river = `river${n}`.slice(0, 20);
  const snapshot: ControlPlaneExport = {
    version: 1,
    exportedAt: "2026-10-28T11:00:00.000Z",
    operators: [alice, bob],
    installations: [install(alice, north), install(bob, river)],
    reservations: [
      { slug: north, operatorSubject: alice.subject, accountId: "c".repeat(32), instanceId: `ins_${north}`, leaseUntil: null },
      { slug: river, operatorSubject: bob.subject, accountId: "c".repeat(32), instanceId: `ins_${river}`, leaseUntil: "2026-10-28T11:20:00.000Z" },
    ],
  };
  return { snapshot, alice, bob, north, river };
}

const source = (snapshot: unknown): ControlPlaneSource & { calls: number } => {
  const fake = { calls: 0, exportSnapshot: async () => { fake.calls++; return structuredClone(snapshot); } };
  return fake;
};

/** Every row of every table, so a run that should write nothing can be checked to have written nothing. */
async function dump(): Promise<Record<string, unknown[]>> {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  return out;
}

async function runImport(deps: ReturnType<typeof adminDeps>, dryRun?: boolean) {
  const response = await call(deps, "POST", "/api/import/control-plane", { body: dryRun === undefined ? {} : { dryRun } });
  expect(response.status).toBe(200);
  return response.json<ImportReport>();
}

describe("the control-plane import", () => {
  it("reports on a dry run what it would do, and writes nothing, not even an audit entry", async () => {
    const { snapshot } = exportFixture();
    const deps = adminDeps({ controlPlane: source(snapshot), keyEncryptionKey: () => Promise.reject(new Error("a dry run needs no key")) });
    const before = await dump();
    const report = await runImport(deps, true);
    expect(report).toEqual({
      dryRun: true,
      exportedAt: "2026-10-28T11:00:00.000Z",
      operators: { created: 2, updated: 0, unchanged: 0 },
      workspaces: { created: 2, matched: 0 },
      installations: { created: 2, updated: 0, unchanged: 0 },
      reservations: { created: 2, updated: 0, unchanged: 0, removed: expect.any(Number) },
      skipped: [],
    });
    // The operators table changed only by the caller's own sign-in, which every /api request records.
    const after = await dump();
    const { operators: _a, ...restAfter } = after;
    const { operators: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after.operators!.length - before.operators!.length).toBeLessThanOrEqual(1);
  });

  it("maps each installation onto a pending workspace with its own ops key, and brings in operators and reservations", async () => {
    const { snapshot, alice, north, river } = exportFixture();
    const clock = manualClock();
    const deps = adminDeps({ controlPlane: source(snapshot), now: clock.now });
    const report = await runImport(deps);
    expect(report).toMatchObject({
      dryRun: false, operators: { created: 2 }, workspaces: { created: 2, matched: 0 }, installations: { created: 2 }, reservations: { created: 2 }, skipped: [],
    });

    const workspaces = await (await call(deps, "GET", "/api/workspaces")).json<Workspace[]>();
    const northfield = workspaces.find((w) => w.slug === north)!;
    expect(northfield).toMatchObject({ origin: `https://${north}.educateos.io`, displayName: north, edition: "oss", status: "pending", enrolledAt: "2026-10-26T14:00:00.000Z" });
    const detail = await (await call(deps, "GET", `/api/workspaces/${northfield.id}`)).json<WorkspaceDetail>();
    expect(detail.key?.keyId).toMatch(/^ed25519-/);

    const listed = await (await call(deps, "GET", "/api/installations")).json<InstallationsResponse>();
    expect(listed.installations.find((i) => i.slug === north)).toEqual({
      instanceId: `ins_${north}`, workspaceId: northfield.id, slug: north, hostname: `${north}.educateos.io`, installedBy: alice.email,
      cloudflareAccountId: "c".repeat(32), releaseVersion: "0.1.0", installedAt: "2026-10-26T14:00:00.000Z", importedAt: clock.now().toISOString(),
    });
    expect(listed.reservations.find((r) => r.slug === river)).toMatchObject({ instanceId: `ins_${river}`, leaseUntil: "2026-10-28T11:20:00.000Z" });

    const operator = await env.DB.prepare("SELECT email, role, account_id FROM operators WHERE sub = ?1").bind(alice.subject).first();
    expect(operator).toEqual({ email: alice.email, role: "installer", account_id: alice.accountId });

    const audit = await (await call(deps, "GET", "/api/audit")).json<AuditPage>();
    expect(audit.entries[0]).toMatchObject({ action: "control-plane.import", result: expect.stringMatching(/^ok:/), operatorEmail: "ops@educateos.io" });
  });

  it("is idempotent: a second run with nothing new changes no row", async () => {
    const { snapshot } = exportFixture();
    const deps = adminDeps({ controlPlane: source(snapshot), now: manualClock().now });
    await runImport(deps);
    const before = await dump();
    const again = await runImport(deps);
    expect(again).toMatchObject({
      operators: { created: 0, updated: 0, unchanged: 2 },
      workspaces: { created: 0, matched: 0 },
      installations: { created: 0, updated: 0, unchanged: 2 },
      reservations: { created: 0, updated: 0, unchanged: 2, removed: 0 },
      skipped: [],
    });
    const after = await dump();
    // Only the audit log grows: the import itself is recorded.
    expect({ ...after, audit_log: [] }).toEqual({ ...before, audit_log: [] });
    expect(after.audit_log!.length).toBe(before.audit_log!.length + 1);
  });

  it("brings in what changed since: a new release, an ended run, a released slug", async () => {
    const { snapshot, north, river } = exportFixture();
    const deps = adminDeps({ controlPlane: source(snapshot), now: manualClock().now });
    await runImport(deps);
    const later = structuredClone(snapshot);
    later.installations[0]!.installation.releaseVersion = "0.2.0";
    later.reservations = later.reservations.filter((r) => r.slug !== north).map((r) => ({ ...r, leaseUntil: null }));
    const report = await runImport(adminDeps({ controlPlane: source(later), now: manualClock().now }));
    expect(report).toMatchObject({ installations: { updated: 1, unchanged: 1 }, reservations: { updated: 1, removed: 1 }, workspaces: { created: 0 } });
    const listed = await (await call(deps, "GET", "/api/installations")).json<InstallationsResponse>();
    expect(listed.installations.find((i) => i.slug === north)?.releaseVersion).toBe("0.2.0");
    expect(listed.reservations.find((r) => r.slug === north)).toBeUndefined();
    expect(listed.reservations.find((r) => r.slug === river)?.leaseUntil).toBeUndefined();
  });

  it("matches a workspace already enrolled at the same slug and origin, and skips one whose slug or origin another holds", async () => {
    const { snapshot, north, river } = exportFixture();
    const deps = adminDeps({ controlPlane: source(snapshot) });
    const enroll = async (slug: string, origin: string) => {
      const response = await call(deps, "POST", "/api/workspaces", { body: { slug, displayName: "Enrolled by hand", origin } });
      expect(response.status).toBe(201);
      return (await response.json<{ workspace: Workspace }>()).workspace;
    };
    const matched = await enroll(north, `https://${north}.educateos.io`);
    await enroll(river, `https://somewhere-else-${river}.example.org`);
    const report = await runImport(deps);
    expect(report.workspaces).toEqual({ created: 0, matched: 1 });
    expect(report.skipped).toEqual([{ instanceId: `ins_${river}`, slug: river, reason: "slug-taken" }]);
    const listed = await (await call(deps, "GET", "/api/installations")).json<InstallationsResponse>();
    expect(listed.installations.find((i) => i.slug === north)?.workspaceId).toBe(matched.id);
    expect(listed.installations.find((i) => i.slug === river)?.workspaceId).toBeUndefined();
    // The hand-enrolled workspace keeps its name and edition.
    expect((await (await call(deps, "GET", `/api/workspaces/${matched.id}`)).json<WorkspaceDetail>()).displayName).toBe("Enrolled by hand");
  });

  it("keeps an operator's role and email here, and only adds their account ID", async () => {
    const { snapshot } = exportFixture();
    const sub = `admin-${crypto.randomUUID()}`;
    snapshot.operators[0] = { ...snapshot.operators[0]!, subject: sub, email: "old-address@installer.example" };
    snapshot.installations[0]!.operatorSubject = sub;
    snapshot.reservations[0]!.operatorSubject = sub;
    const deps = adminDeps({ controlPlane: source(snapshot), adminsList: "ops@educateos.io" });
    const signedIn = await call(deps, "GET", "/api/me", { token: await assertion({ sub, email: "ops@educateos.io" }) });
    await signedIn.body?.cancel();
    const report = await runImport(deps);
    expect(report.operators).toEqual({ created: 1, updated: 1, unchanged: 0 });
    const row = await env.DB.prepare("SELECT email, role, account_id FROM operators WHERE sub = ?1").bind(sub).first();
    expect(row).toEqual({ email: "ops@educateos.io", role: "admin", account_id: snapshot.operators[0]!.accountId });
  });

  it("stores no personal data outside the operators table", async () => {
    const { snapshot, alice, bob } = exportFixture();
    await runImport(adminDeps({ controlPlane: source(snapshot) }));
    const { operators, ...rest } = await dump();
    const stored = JSON.stringify(rest);
    for (const value of [alice.email, bob.email, "@installer.example"]) expect(stored, value).not.toContain(value);
    expect(JSON.stringify(operators)).toContain(alice.email);
  });

  it("is for admins of the hosted edition with the binding, and refuses a bad export", async () => {
    const { snapshot } = exportFixture();
    const viewer = await call(adminDeps({ controlPlane: source(snapshot) }), "POST", "/api/import/control-plane", {
      token: await assertion({ sub: "sub-viewer", email: "viewer@educateos.io" }),
    });
    expect(viewer.status).toBe(403);
    const oss = await call(adminDeps({ controlPlane: source(snapshot), edition: "oss" }), "POST", "/api/import/control-plane");
    expect(oss.status).toBe(404);
    const unbound = await call(adminDeps(), "POST", "/api/import/control-plane");
    expect(unbound.status).toBe(503);
    const malformed = await call(adminDeps({ controlPlane: source({ ...snapshot, version: 2 }) }), "POST", "/api/import/control-plane");
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toMatchObject({ code: "control-plane-unavailable" });
    const down = await call(adminDeps({ controlPlane: { exportSnapshot: () => Promise.reject(new Error("no route")) } }), "POST", "/api/import/control-plane");
    expect(down.status).toBe(502);
    const extra = await call(adminDeps({ controlPlane: source(snapshot) }), "POST", "/api/import/control-plane", { body: { dryRun: true, force: true } });
    expect(extra.status).toBe(400);
    for (const response of [viewer, oss, unbound, down, extra]) await response.body?.cancel();
    const listed = await call(adminDeps({ edition: "oss" }), "GET", "/api/installations");
    expect(listed.status).toBe(404);
    await listed.body?.cancel();
  });
});
