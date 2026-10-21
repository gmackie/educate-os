import { describe, expect, it } from "vitest";
import {
  AGENT_KEY_SECRET,
  applyPlan,
  compileDesiredState,
  install,
  OWNERSHIP_TOKEN_SECRET,
  planInstall,
  staticSecretSource,
} from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  makeRoot,
  mutations,
  NORTHFIELD,
  replaceModule,
  RIVERBEND,
  SECRETS,
  tokenFor,
} from "./support.ts";

async function installOnce(fake: ReturnType<typeof accountFor>, release: Awaited<ReturnType<typeof goldenRelease>>, extra: Partial<Parameters<typeof install>[0]> = {}) {
  const { tokens } = tokenFor(fake, "district-run");
  return await install({
    api: fake.api(tokens),
    config: configFor(NORTHFIELD, release),
    manifest: release.manifest,
    artifacts: release.artifacts,
    secrets: SECRETS,
    ...extra,
  });
}

describe("test-account deploy", () => {
  it("installs the pinned release, serves it on the district hostname and registers with the root", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const root = makeRoot();

    const report = await installOnce(fake, release, { registry: root.endpoint });

    expect(report.status).toBe("applied");
    expect(fake.serving("schoolos.northfield.example")).toEqual({
      scriptName: "schoolos-northfield-router",
      releaseId: release.manifest.releaseId,
    });
    // Backend, router, the three preinstalled gatekeepers and the one the district chose.
    expect(fake.inventory()).toMatchObject({
      workers: 6,
      kvNamespaces: 3,
      r2Buckets: 1,
      accessPolicies: 1,
      accessApplications: 1,
      aiGateways: 1,
      domains: 1,
    });
    expect(fake.worker("schoolos-northfield-gatekeeper-google")!.secretNames).toEqual(["CLIENT_ID", "CLIENT_SECRET"]);

    expect(report.registration?.status).toBe("registered");
    const [record] = await root.storage.list();
    expect(record).toMatchObject({ instanceId: "ins_northfield", districtLabel: NORTHFIELD.district.name, releaseVersion: "0.1.0" });
    // The district, not the installer, now holds the agent key and the ownership token.
    expect(fake.worker("schoolos-northfield-workshop-backend")!.secretNames).toEqual([AGENT_KEY_SECRET, OWNERSHIP_TOKEN_SECRET]);
  });

  it("wires the backend to Access, the gatekeepers and the account's own resources", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    await installOnce(fake, release);

    const bindings = fake.worker("schoolos-northfield-workshop-backend")!.bindings;
    const byName = new Map(bindings.map((b) => [b.name, b]));
    expect(byName.get("PUBLIC_BASE_URL")).toMatchObject({ type: "plain_text", text: "https://schoolos.northfield.example" });
    expect(byName.get("CF_ACCESS_ISS")).toMatchObject({ text: "https://northfield.cloudflareaccess.com" });
    expect(byName.get("CF_ACCESS_AUD")?.text).toMatch(/^aud-/);
    expect(byName.get("ADMINS")).toMatchObject({ type: "json", json: ["avery.admin@northfield.example"] });
    expect(byName.get("BLUEPRINTS")?.namespace_id).toMatch(/^kv-/);
    expect(byName.get("BLUEPRINT_CONTENT")).toMatchObject({ bucket_name: "schoolos-northfield-blueprint-content" });
    expect(byName.get("GATEKEEPER_CONTEXT")).toMatchObject({
      service: "schoolos-northfield-gatekeeper-context",
      entrypoint: "GatekeeperVendor",
      props: { sharingDomain: "https://schoolos.northfield.example" },
    });
    expect(byName.get("GATEKEEPER_GOOGLE")).toMatchObject({ service: "schoolos-northfield-gatekeeper-google" });
    // No placeholder survives into an uploaded binding.
    expect(JSON.stringify(bindings)).not.toMatch(/\$[A-Z]/);
  });

  it("is idempotent: a second run plans nothing and makes no change", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const root = makeRoot();
    await installOnce(fake, release, { registry: root.endpoint });
    const before = { inventory: fake.inventory(), mutations: mutations(fake).length };

    const again = await installOnce(fake, release, { registry: root.endpoint });

    expect(again.plan!.steps.every((s) => s.action === "noop")).toBe(true);
    expect(again.registration?.status).toBe("already-registered");
    expect(fake.inventory()).toEqual(before.inventory);
    expect(mutations(fake)).toHaveLength(before.mutations);
    expect(await root.storage.list()).toHaveLength(1);
  });

  it("keeps two districts' installs apart in their own accounts", async () => {
    const release = await goldenRelease();
    const northfield = accountFor(NORTHFIELD);
    const riverbend = accountFor(RIVERBEND);
    const { tokens } = tokenFor(riverbend, "district-run");
    await installOnce(northfield, release);
    await install({
      api: riverbend.api(tokens),
      config: configFor(RIVERBEND, release),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS,
    });
    expect(riverbend.serving("schoolos.riverbend.example")?.scriptName).toBe("schoolos-riverbend-router");
    expect(northfield.serving("schoolos.riverbend.example")).toBeUndefined();
  });
});

describe("dry run", () => {
  it("observes and plans with a cost summary, changing nothing", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);

    const report = await installOnce(fake, release, { dryRun: true });

    expect(report.status).toBe("planned");
    expect(mutations(fake)).toHaveLength(0);
    expect(report.plan!.steps.filter((s) => s.action === "create")).toHaveLength(report.plan!.steps.length);
    const products = Object.fromEntries(report.plan!.cost.map((line) => [line.product, line]));
    expect(products["Workers (Workers Paid plan)"]).toMatchObject({ total: 6, creating: 6 });
    expect(products["Workers KV"]).toMatchObject({ total: 3, creating: 3 });
    expect(products["Zero Trust Access"]?.billedBy).toMatch(/seats/);
    expect(products["Durable Objects (SQLite)"]!.total).toBeGreaterThan(0);
  });

  it("never puts a secret value in the plan", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const report = await installOnce(fake, release, { dryRun: true });
    expect(JSON.stringify(report)).not.toContain("synthetic-google-client-secret");
  });
});

describe("interrupted retry", () => {
  // Interrupt at points across the run: storage, Access, Worker uploads, the asset upload, secrets,
  // the custom domain and the registration's first secret. Both with the change landing (only the
  // response lost) and without.
  const cases = [1, 4, 6, 7, 8, 12, 13, 14, 15, 16, 18, 19].flatMap((ordinal) =>
    [true, false].map((effectApplied) => ({ ordinal, effectApplied })));

  it.each(cases)("resumes after mutation $ordinal is interrupted (effect applied: $effectApplied)", async ({ ordinal, effectApplied }) => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const root = makeRoot();
    fake.interruptMutation(ordinal, { effectApplied });

    await expect(installOnce(fake, release, { registry: root.endpoint })).rejects.toMatchObject({ code: "unavailable" });
    const resumed = await installOnce(fake, release, { registry: root.endpoint });

    expect(resumed.status).toBe("applied");
    expect(resumed.registration?.status).toBe("registered");
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe(release.manifest.releaseId);
    expect(fake.inventory()).toMatchObject({ workers: 6, kvNamespaces: 3, r2Buckets: 1, accessPolicies: 1, accessApplications: 1, aiGateways: 1, domains: 1 });
    expect(await root.storage.list()).toHaveLength(1);
    const settled = await installOnce(fake, release, { registry: root.endpoint });
    expect(settled.plan!.steps.every((s) => s.action === "noop")).toBe(true);
    expect(settled.registration?.status).toBe("already-registered");
  });

  it("reports, rather than hides, a registration whose ownership token was lost", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const root = makeRoot();
    // The 20th mutation stores the ownership token, after the root has registered the instance.
    fake.interruptMutation(20, { effectApplied: false });
    await expect(installOnce(fake, release, { registry: root.endpoint })).rejects.toMatchObject({ code: "unavailable" });

    const retried = await installOnce(fake, release, { registry: root.endpoint });

    expect(retried.status).toBe("applied");
    expect(retried.registration).toMatchObject({ status: "conflict", operatorAction: expect.stringContaining("support") });
    expect(fake.serving("schoolos.northfield.example")).toBeDefined();
  });
});

describe("ownership", () => {
  it("refuses, before any change, a Worker in its namespace that the installer did not create", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    fake.seedWorker("schoolos-northfield-router");

    const report = await installOnce(fake, release);

    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked).toEqual([
      expect.objectContaining({ key: "worker:router", action: "refuse", reason: expect.stringContaining("not created by the SchoolOS installer") }),
    ]);
    expect(mutations(fake)).toHaveLength(0);
  });

  it("refuses a Worker that belongs to another instance", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    fake.seedWorker("schoolos-northfield-workshop-backend", { SCHOOLOS_INSTANCE_ID: "ins_riverbend" });

    const report = await installOnce(fake, release);

    expect(report.plan!.blocked.map((s) => s.reason)).toEqual(["Worker schoolos-northfield-workshop-backend belongs to instance ins_riverbend"]);
    expect(mutations(fake)).toHaveLength(0);
  });

  it("refuses an Access application or custom domain already serving the hostname", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    fake.seedAccessApplication("Legacy portal", "schoolos.northfield.example");
    fake.seedWorker("legacy-portal");
    fake.seedWorkerDomain("schoolos.northfield.example", "legacy-portal");

    const report = await installOnce(fake, release);

    expect(report.plan!.blocked.map((s) => s.key)).toEqual(["access:application", "domain:public"]);
    expect(mutations(fake)).toHaveLength(0);
  });

  it("applyPlan itself refuses a blocked plan", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    fake.seedWorker("schoolos-northfield-router");
    const { tokens } = tokenFor(fake, "district-run");
    const api = fake.api(tokens);
    const plan = await planInstall(api, compileDesiredState(release.manifest, configFor(NORTHFIELD, release)), SECRETS);

    await expect(applyPlan(plan, { api, artifacts: release.artifacts, secrets: SECRETS })).rejects.toMatchObject({ code: "forbidden" });
    expect(mutations(fake)).toHaveLength(0);
  });

  it("asks for a gatekeeper secret it has not been given instead of installing without it", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const report = await installOnce(fake, release, { secrets: staticSecretSource({}) });
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual([
      "supply CLIENT_ID for gatekeeper-google",
      "supply CLIENT_SECRET for gatekeeper-google",
    ]);
    expect(mutations(fake)).toHaveLength(0);
  });
});

describe("upgrade", () => {
  it("uploads only what changed and chains Durable Object migrations from the deployed tag", async () => {
    const r1 = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    await installOnce(fake, r1);

    const r2 = await deriveRelease(r1, "r000001-fixture", async (manifest, artifacts) => {
      await replaceModule(manifest, artifacts, "gatekeeper-scheduler", "export default {}; // r2\n");
      manifest.workers["gatekeeper-scheduler"]!.migrations.push({ tag: "v2", new_sqlite_classes: ["ScheduleAudit"] });
    });
    const { tokens } = tokenFor(fake, "district-run");
    const report = await install({
      api: fake.api(tokens),
      config: configFor(NORTHFIELD, r2),
      manifest: r2.manifest,
      artifacts: r2.artifacts,
      secrets: SECRETS,
    });

    // Every Worker's release marker changes, so each is re-uploaded; storage and Access are untouched.
    expect(report.plan!.steps.filter((s) => s.action !== "noop").map((s) => s.kind).toSorted()).toEqual(
      Array(6).fill("worker_script"),
    );
    expect(fake.worker("schoolos-northfield-gatekeeper-scheduler")!.migrationTag).toBe("v2");
    expect(fake.serving("schoolos.northfield.example")?.releaseId).toBe("r000001-fixture");
  });

  it("refuses to install an older release over a newer Durable Object migration", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (manifest) => {
      manifest.workers["gatekeeper-scheduler"]!.migrations.push({ tag: "v2", new_sqlite_classes: ["ScheduleAudit"] });
    });
    const fake = accountFor(NORTHFIELD);
    const { tokens } = tokenFor(fake, "district-run");
    const run = (release: typeof r1) => install({
      api: fake.api(tokens),
      config: configFor(NORTHFIELD, release),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS,
    });
    await run(r2);

    const downgrade = await run(r1);

    expect(downgrade.status).toBe("plan-blocked");
    expect(downgrade.plan!.blocked[0]!.reason).toContain("migration tag v2");
  });
});
