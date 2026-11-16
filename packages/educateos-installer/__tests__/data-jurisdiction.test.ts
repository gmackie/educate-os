// Data jurisdiction (SCHO-374, ADR-0015): `dataJurisdiction: "us"` creates the install's KV
// namespaces, R2 buckets and D1 databases in Cloudflare's US jurisdiction, binds its buckets there, and pins the district's
// Durable Object with DATA_JURISDICTION. Cloudflare can't move storage between jurisdictions, so the
// installer refuses to pin, unpin or re-pin anything that already exists.
import { describe, expect, it } from "vitest";
import {
  compileDesiredState,
  type DesiredD1Database,
  type DesiredKvNamespace,
  type DesiredR2Bucket,
  type DesiredWorker,
  install,
  rollback,
} from "../src/index.ts";
import { accountFor, configFor, deriveRelease, goldenRelease, NORTHFIELD, SECRETS, type TestRelease, tokenFor } from "./support.ts";

const DISTRICT = "educateos-district-worker";
const DISTRICT_SCRIPT = "educateos-northfield-educateos-district-worker";
const BUCKET = "educateos-northfield-blueprint-content";
const ADMIN_DB = "educateos-northfield-admin-db";
const AVATARS = "educateos-northfield-avatars";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: "the district's own config" }) };
const US = { dataJurisdiction: "us" };

/** A one-origin Northfield with the OSS admin, which brings a D1 database. */
function config(release: TestRelease, overrides: Record<string, unknown> = {}) {
  return configFor(NORTHFIELD, release, {
    services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } },
    admin: { enabled: true },
    ...overrides,
  });
}

function compile(release: TestRelease, overrides: Record<string, unknown> = {}) {
  const desired = compileDesiredState(release.manifest, config(release, overrides));
  const byKey = new Map(desired.resources.map((r) => [r.key, r]));
  return { desired, get: <T>(key: string) => byKey.get(key) as T };
}

const plain = (worker: DesiredWorker, name: string) => worker.bindings.find((b) => b.name === name);

/** The golden release as one from before ADR-0015, whose district ignores DATA_JURISDICTION. */
async function unpinnableRelease(base: TestRelease) {
  return await deriveRelease(base, "r000000-unpinnable", (m) => {
    delete m.workers[DISTRICT]!.vars.DATA_JURISDICTIONS_SUPPORTED;
  });
}

function setup() {
  const fake = accountFor(NORTHFIELD);
  const api = fake.api(tokenFor(fake, "district-run").tokens);
  const run = (release: TestRelease, overrides: Record<string, unknown> = {}, dryRun = false) =>
    install({ api, config: config(release, overrides), manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS, dryRun });
  return { fake, api, run };
}

describe("a US-pinned install's desired state", () => {
  it("pins the district, its storage and its bucket bindings to us", async () => {
    const release = await goldenRelease();
    expect(release.manifest.workers[DISTRICT]!.vars).toMatchObject({ DATA_JURISDICTIONS_SUPPORTED: "us" });
    const { desired, get } = compile(release, US);

    expect(desired.dataJurisdiction).toBe("us");
    expect(plain(get<DesiredWorker>(`worker:${DISTRICT}`), "DATA_JURISDICTION")).toEqual({ type: "plain_text", name: "DATA_JURISDICTION", text: "us" });
    expect(get<DesiredR2Bucket>("r2:BLUEPRINT_CONTENT")).toMatchObject({ name: BUCKET, jurisdiction: "us" });
    expect(get<DesiredD1Database>(`d1:educateos-admin:DB`)).toMatchObject({ name: ADMIN_DB, jurisdiction: "us" });
    const kv = desired.resources.filter((r): r is DesiredKvNamespace => r.kind === "kv_namespace");
    expect(kv.map((ns) => [ns.key, ns.jurisdiction])).toEqual([["kv:AVATARS", "us"], ["kv:BLUEPRINTS", "us"], ["kv:CONTEXT_COLLECTIONS", "us"]]);
    expect(plain(get<DesiredWorker>("worker:workshop-backend"), "BLUEPRINT_CONTENT"))
      .toEqual({ type: "r2_bucket", name: "BLUEPRINT_CONTENT", bucket_name: BUCKET, jurisdiction: "us" });
    // Only the district reads the var; no other Worker gets it.
    const others = desired.resources.filter((r): r is DesiredWorker => r.kind === "worker_script" && r.pkgName !== DISTRICT);
    expect(others.filter((w) => plain(w, "DATA_JURISDICTION"))).toEqual([]);
  });

  it("pins nothing without dataJurisdiction, as every install before ADR-0015", async () => {
    const { desired, get } = compile(await goldenRelease());
    expect(desired.dataJurisdiction).toBeUndefined();
    expect(plain(get<DesiredWorker>(`worker:${DISTRICT}`), "DATA_JURISDICTION")).toBeUndefined();
    expect(get<DesiredR2Bucket>("r2:BLUEPRINT_CONTENT").jurisdiction).toBeUndefined();
    expect(get<DesiredD1Database>(`d1:educateos-admin:DB`).jurisdiction).toBeUndefined();
    expect(get<DesiredKvNamespace>("kv:AVATARS").jurisdiction).toBeUndefined();
    expect(plain(get<DesiredWorker>("worker:workshop-backend"), "BLUEPRINT_CONTENT")).not.toHaveProperty("jurisdiction");
  });

  it("refuses a release whose district can't be pinned, rather than claim a pin it would ignore", async () => {
    const old = await unpinnableRelease(await goldenRelease());
    expect(() => compile(old, US)).toThrow(/educateos-district-worker in release r000000-unpinnable can't keep its Durable Object in the us jurisdiction/);
    expect(() => compile(old)).not.toThrow();
  });

  it("rejects a jurisdiction EducateOS does not pin to", async () => {
    const release = await goldenRelease();
    expect(() => config(release, { dataJurisdiction: "eu" })).toThrow();
  });
});

describe("installing a US-pinned district", () => {
  it("creates its bucket and database in us, binds the bucket there, and pins the district", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    expect((await run(release, US)).status).toBe("applied");

    expect(fake.r2Jurisdictions(BUCKET)).toEqual(["us"]);
    expect(fake.d1Jurisdiction(ADMIN_DB)).toBe("us");
    expect(fake.kvJurisdiction(AVATARS)).toBe("us");
    expect(fake.worker(DISTRICT_SCRIPT)!.bindings).toContainEqual({ type: "plain_text", name: "DATA_JURISDICTION", text: "us" });
    // The fake refuses a binding to a bucket that isn't there, so this upload bound the us bucket.
    expect(fake.worker("educateos-northfield-workshop-backend")!.bindings)
      .toContainEqual({ type: "r2_bucket", name: "BLUEPRINT_CONTENT", bucket_name: BUCKET, jurisdiction: "us" });

    // A second run finds everything in place.
    const again = await run(release, US, true);
    expect(again.plan!.steps.filter((s) => s.action !== "noop").map((s) => s.key)).toEqual([]);
  });

  it("never unpins it: an apply without dataJurisdiction is refused", async () => {
    const release = await goldenRelease();
    const { run } = setup();
    await run(release, US);

    const report = await run(release, {});
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => [s.key, s.reason])).toEqual(expect.arrayContaining([
      [`worker:${DISTRICT}`, `Worker ${DISTRICT_SCRIPT} keeps its Durable Objects in the us jurisdiction; unpinning it would start it on empty objects, leaving its data behind (ADR-0015)`],
      [`d1:educateos-admin:DB`, `D1 database ${ADMIN_DB} is in us, not none, and Cloudflare can't move it (ADR-0015)`],
      ["r2:BLUEPRINT_CONTENT", `R2 bucket ${BUCKET} is in us, not none, and Cloudflare can't move it (ADR-0015)`],
      ["kv:AVATARS", `KV namespace ${AVATARS} is in us, not none, and Cloudflare can't move it (ADR-0015)`],
    ]));
  });

  it("refuses a rollback to a release whose district can't be pinned", async () => {
    const golden = await goldenRelease();
    const old = await unpinnableRelease(golden);
    const { api, run } = setup();
    await run(golden, US);

    await expect(rollback({ api, config: config(golden, US), current: golden.manifest, previous: old.manifest, dryRun: true }))
      .rejects.toThrow(/can't keep its Durable Object in the us jurisdiction/);
  });
});

describe("an existing unpinned install", () => {
  it("is not pinned in place: its district, bucket and database are refused, and nothing changes", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();
    await run(release);
    const before = fake.inventory();

    const report = await run(release, US);
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => [s.key, s.reason])).toEqual(expect.arrayContaining([
      [`worker:${DISTRICT}`, `Worker ${DISTRICT_SCRIPT} keeps its Durable Objects in no jurisdiction; pinning it to us would start it on empty objects, leaving its data behind (ADR-0015)`],
      ["r2:BLUEPRINT_CONTENT", `R2 bucket ${BUCKET} is in no jurisdiction, not us, and Cloudflare can't move it (ADR-0015)`],
      ["kv:AVATARS", `KV namespace ${AVATARS} is in no jurisdiction, not us, and Cloudflare can't move it (ADR-0015)`],
      [`d1:educateos-admin:DB`, `D1 database ${ADMIN_DB} is in no jurisdiction, not us, and Cloudflare can't move it (ADR-0015)`],
    ]));
    expect(fake.inventory()).toEqual(before);
    expect(fake.r2Jurisdictions(BUCKET)).toEqual(["default"]);
  });

  it("refuses to adopt a deployed, unpinned district into a pinned install", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
    fake.seedDeployedWorker("educateos-northfield-district", { migrationTag: "v1" });
    const api = fake.api(tokenFor(fake, "district-run").tokens);

    const report = await install({
      api,
      config: configFor(NORTHFIELD, release, {
        ...US,
        services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS, scriptName: "educateos-northfield-district" } },
      }),
      manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS, dryRun: true,
    });
    expect(report.plan!.blocked.find((s) => s.key === `worker:${DISTRICT}`)?.reason)
      .toBe("Worker educateos-northfield-district keeps its Durable Objects in no jurisdiction; pinning it to us would start it on empty objects, leaving its data behind (ADR-0015)");
  });
});
