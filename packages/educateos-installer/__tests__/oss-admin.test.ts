// The open-source EducateOS admin in the district's own account (SCHO-263): with `admin.enabled`,
// the installer adds the admin Worker (EDITION=oss, this install's origin only), its own D1 database
// with the release's migrations, a generated key encryption key, its Access applications and its
// custom domain. Off (the default), the install is exactly what it was.
import { describe, expect, it } from "vitest";
import {
  ADMIN_ACCESS_BYPASS_PATHS,
  adminNextSteps,
  compileDesiredState,
  type DesiredAccessApplication,
  type DesiredCustomDomain,
  type DesiredD1Database,
  type DesiredWorker,
  type DesiredWorkerSecret,
  dryRunDrift,
  install,
  planInstall,
  type ReleaseManifest,
  rollback,
} from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  NORTHFIELD,
  replaceModule,
  SECRETS,
  type TestRelease,
  tokenFor,
} from "./support.ts";

const ADMIN = "educateos-admin";
const DISTRICT = "educateos-district-worker";
const HOST = "educateos.northfield.example";
const ADMIN_HOST = "admin.northfield.example";
const SCRIPT = "educateos-northfield-educateos-admin";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: "the district's own config" }) };
const STAFF = NORTHFIELD.principals.find((p) => p.kind === "staff")!.email;

type ConfigOverrides = Record<string, unknown>;

/** A one-origin install of Northfield, with the OSS admin unless `overrides` say otherwise. */
function adminConfig(release: TestRelease, overrides: ConfigOverrides = {}) {
  return configFor(NORTHFIELD, release, {
    services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } },
    admin: { enabled: true },
    ...overrides,
  });
}

function compile(release: TestRelease, overrides: ConfigOverrides = {}) {
  const desired = compileDesiredState(release.manifest, adminConfig(release, overrides));
  const byKey = new Map(desired.resources.map((r) => [r.key, r]));
  return {
    desired,
    order: desired.resources.map((r) => r.key),
    get: <T>(key: string) => byKey.get(key) as T | undefined,
  };
}

const binding = (worker: { bindings: { name: string }[] } | undefined, name: string) => worker?.bindings.find((b) => b.name === name);

/** The release without its admin entry: the release as it was before SCHO-263, under the same ID. */
function withoutAdmin(manifest: ReleaseManifest): ReleaseManifest {
  const copy = structuredClone(manifest);
  delete copy.workers[ADMIN];
  return copy;
}

function setup() {
  const fake = accountFor(NORTHFIELD);
  const { tokens } = tokenFor(fake, "district-run");
  const api = fake.api(tokens);
  const options = (release: TestRelease, overrides: ConfigOverrides = {}) => ({
    api,
    config: adminConfig(release, overrides),
    manifest: release.manifest,
    artifacts: release.artifacts,
    secrets: SECRETS,
  });
  const run = (release: TestRelease, overrides: ConfigOverrides = {}) => install(options(release, overrides));
  return { fake, api, run, options };
}

describe("OSS admin desired state", () => {
  it("adds the admin Worker as the oss edition of this origin, with its own D1, generated key and SPA", async () => {
    const release = await goldenRelease();
    const { get, desired } = compile(release);
    const admin = get<DesiredWorker>(`worker:${ADMIN}`)!;

    expect(admin).toMatchObject({ scriptName: SCRIPT, role: "admin" });
    expect(binding(admin, "EDITION")).toEqual({ type: "plain_text", name: "EDITION", text: "oss" });
    expect(binding(admin, "OSS_WORKSPACE_ORIGINS")).toEqual({ type: "plain_text", name: "OSS_WORKSPACE_ORIGINS", text: `https://${HOST}` });
    expect(binding(admin, "ACCESS_ISSUER")).toEqual({ type: "plain_text", name: "ACCESS_ISSUER", text: "https://northfield.cloudflareaccess.com" });
    expect(binding(admin, "ACCESS_AUD")).toEqual({ type: "plain_text", name: "ACCESS_AUD", text: { ref: "access:application:admin", output: "aud" } });
    expect(binding(admin, "ADMINS")).toEqual({ type: "plain_text", name: "ADMINS", text: STAFF });
    expect(binding(admin, "DB")).toEqual({ type: "d1", name: "DB", id: { ref: `d1:${ADMIN}:DB`, output: "id" } });
    expect(binding(admin, "ASSETS")).toEqual({ type: "assets", name: "ASSETS" });
    // No secret value in the Worker's bindings: the key is a separate, generated secret.
    expect(binding(admin, "ADMIN_KEY_ENCRYPTION_KEY")).toBeUndefined();
    expect(get<DesiredWorkerSecret>(`secret:${ADMIN}:ADMIN_KEY_ENCRYPTION_KEY`)).toMatchObject({ scriptName: SCRIPT, generated: true });
    expect(desired.inputs.filter((i) => i.pkgName === ADMIN)).toEqual([
      expect.objectContaining({ name: "ADMIN_KEY_ENCRYPTION_KEY", kind: "secret", generated: true }),
    ]);

    // Its own database, named apart from any other Worker's `DB`, with every admin migration.
    const db = get<DesiredD1Database>(`d1:${ADMIN}:DB`)!;
    expect(db.name).toBe("educateos-northfield-admin-db");
    expect(db.migrations.map((m) => m.id)).toEqual(["0001_initial", "0002_control_plane"]);
    expect(get(`d1:DB`)).toBeUndefined();

    const spa = release.manifest.workers[ADMIN]!.assetsConfig!;
    expect(admin.assets).toEqual({
      manifest: spa.variants.spa!.manifest,
      config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/healthz"] },
    });
    // Nothing else binds or is bound to it.
    expect(admin.bindings.some((b) => b.type === "service")).toBe(false);
    for (const resource of desired.resources) {
      if (resource.kind === "worker_script" && resource.pkgName !== ADMIN) expect(JSON.stringify(resource.bindings)).not.toContain(SCRIPT);
    }
  });

  it("lists every install admin in ADMINS", async () => {
    const release = await goldenRelease();
    const { get } = compile(release, { admins: [STAFF, "it-lead@northfield.example"] });
    expect(binding(get<DesiredWorker>(`worker:${ADMIN}`), "ADMINS")).toMatchObject({ text: `${STAFF},it-lead@northfield.example` });
  });

  it("puts the admin's hostname behind the members policy, bypasses only /healthz, and serves it after both", async () => {
    const release = await goldenRelease();
    const { get, order } = compile(release);
    const app = get<DesiredAccessApplication>("access:application:admin")!;
    expect(app).toMatchObject({ name: "educateos-northfield-admin", domain: ADMIN_HOST, destinations: [ADMIN_HOST], policyKey: "access:policy" });
    const bypass = get<DesiredAccessApplication>("access:application:admin:bypass")!;
    expect(ADMIN_ACCESS_BYPASS_PATHS).toEqual(["/healthz"]);
    expect(bypass).toMatchObject({
      name: "educateos-northfield-admin-bypass", domain: `${ADMIN_HOST}/healthz`, destinations: [`${ADMIN_HOST}/healthz`], policyKey: "access:policy:bypass",
    });
    // The district's own applications are unchanged.
    expect(get<DesiredAccessApplication>("access:application")!.destinations).not.toContain(ADMIN_HOST);

    const domain = get<DesiredCustomDomain>("domain:admin")!;
    expect(domain).toMatchObject({ hostname: ADMIN_HOST, zoneName: "northfield.example", scriptName: SCRIPT });
    for (const before of ["access:application:admin", "access:application:admin:bypass", `worker:${ADMIN}`, `secret:${ADMIN}:ADMIN_KEY_ENCRYPTION_KEY`]) {
      expect(order.indexOf(before)).toBeLessThan(order.indexOf("domain:admin"));
    }
    expect(order.indexOf(`d1:${ADMIN}:DB`)).toBeLessThan(order.indexOf(`worker:${ADMIN}`));
    expect(order.indexOf("domain:public")).toBeLessThan(order.indexOf("domain:admin"));
  });

  it("uses a configured hostname under the base domain", async () => {
    const release = await goldenRelease();
    const { get } = compile(release, { admin: { enabled: true, hostname: "ops.northfield.example" } });
    expect(get<DesiredCustomDomain>("domain:admin")?.hostname).toBe("ops.northfield.example");
    expect(get<DesiredAccessApplication>("access:application:admin")?.domain).toBe("ops.northfield.example");
    expect(adminNextSteps(adminConfig(release, { admin: { enabled: true, hostname: "ops.northfield.example" } }))[0])
      .toContain("https://ops.northfield.example");
  });

  it("refuses an admin without one origin, outside the zone, on the district's hostname, or from a release without one", async () => {
    const release = await goldenRelease();
    expect(() => compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { admin: { enabled: true } })))
      .toThrow(/needs a one-origin install/);
    expect(() => compile(release, { admin: { enabled: true, hostname: "admin.elsewhere.example" } }))
      .toThrow(/must be under northfield\.example/);
    expect(() => compile(release, { admin: { enabled: true, hostname: HOST } })).toThrow(/a hostname of its own/);
    expect(() => compile(release, { subdomain: "admin" })).toThrow(/a hostname of its own, not admin\.northfield\.example/);
    expect(() => compile(release, { admin: { enabled: true, hostname: "Admin.Northfield.example" } })).toThrow();
    expect(() => compileDesiredState(withoutAdmin(release.manifest), adminConfig(release)))
      .toThrow(/needs a release that carries the OSS admin/);
  });

  it("refuses an admin that asks for an input the installer can't supply", async () => {
    const release = await goldenRelease();
    const manifest = structuredClone(release.manifest);
    manifest.workers[ADMIN]!.inputs = [{ name: "ADMINS", kind: "var", label: "Admins" }];
    expect(() => compileDesiredState(manifest, adminConfig(release))).toThrow(/asks for ADMINS/);
  });
});

describe("OSS admin off", () => {
  it("is the default, and compiles to exactly the desired state of a release without the admin", async () => {
    const release = await goldenRelease();
    for (const overrides of [{}, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } } }]) {
      const config = configFor(NORTHFIELD, release, overrides);
      expect(config.admin).toEqual({ enabled: false });
      const today = JSON.stringify(compileDesiredState(withoutAdmin(release.manifest), config));
      expect(JSON.stringify(compileDesiredState(release.manifest, config))).toBe(today);
      expect(JSON.stringify(compileDesiredState(release.manifest, { ...config, admin: { enabled: false, hostname: "ops.northfield.example" } }))).toBe(today);
      expect(today).not.toContain(ADMIN);
    }
    expect(adminNextSteps(configFor(NORTHFIELD, release))).toEqual([]);
  });

  it("plans and reports byte for byte as before, on a fresh account and after an install", async () => {
    const release = await goldenRelease();
    const config = configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } } });
    const before = { ...release, manifest: withoutAdmin(release.manifest) };
    const { api } = setup();
    const plans = async () => await Promise.all([release, before].map(async (r) => {
      const plan = await planInstall(api, compileDesiredState(r.manifest, config), SECRETS);
      const report = await install({ api, config, manifest: r.manifest, artifacts: r.artifacts, secrets: SECRETS, dryRun: true });
      return [JSON.stringify(plan), JSON.stringify(report)];
    }));
    const [fresh, freshBefore] = await plans();
    expect(fresh).toEqual(freshBefore);
    expect(fresh[1]).not.toContain("nextSteps");

    expect((await install({ api, config, manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS })).status).toBe("applied");
    const [after, afterBefore] = await plans();
    expect(after).toEqual(afterBefore);
  });
});

describe("OSS admin install", () => {
  it("installs the admin with its migrations, a generated key and its domain, and a second run changes nothing", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    const report = await run(release);
    expect(report.preflight.blocking).toEqual([]);
    expect(report.status).toBe("applied");

    const admin = fake.worker(SCRIPT)!;
    expect(admin.secretNames).toEqual(["ADMIN_KEY_ENCRYPTION_KEY"]);
    const key = fake.secretValue(SCRIPT, "ADMIN_KEY_ENCRYPTION_KEY")!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(report)).not.toContain(key);
    expect(binding(admin, "ACCESS_AUD")).toMatchObject({ text: fake.accessApplication("educateos-northfield-admin")!.aud });
    expect(fake.accessApplication("educateos-northfield-admin")!.aud).not.toBe(fake.accessApplication("educateos-northfield")!.aud);
    expect(fake.accessApplication("educateos-northfield-admin-bypass")?.destinations).toEqual([`${ADMIN_HOST}/healthz`]);
    expect(fake.serving(ADMIN_HOST)?.scriptName).toBe(SCRIPT);
    expect(fake.serving(HOST)?.scriptName).toBe("educateos-northfield-router");

    // Both migrations ran, in order, each in one request with its ledger row.
    const [initial, controlPlane, ...rest] = fake.d1Statements("educateos-northfield-admin-db");
    expect(rest).toEqual([]);
    expect(initial).toMatch(/CREATE TABLE operators/);
    expect(controlPlane).toMatch(/CREATE TABLE installations/);

    // The manual enrollment is the summary's next step.
    expect(report.nextSteps).toHaveLength(3);
    expect(report.nextSteps![0]).toContain(`https://${ADMIN_HOST}`);
    expect(report.nextSteps![1]).toContain(`https://${HOST}/admin`);

    const again = await run(release);
    expect(again.status).toBe("applied");
    expect(again.plan!.steps.filter((s) => s.action !== "noop")).toEqual([]);
    expect(fake.secretValue(SCRIPT, "ADMIN_KEY_ENCRYPTION_KEY")).toBe(key);
  });

  it("blocks on DNS records already at the admin's hostname", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD, { dnsRecords: [{ type: "A", name: ADMIN_HOST, content: "192.0.2.1" }] });
    const { tokens } = tokenFor(fake, "district-run");
    const report = await install({ api: fake.api(tokens), config: adminConfig(release), manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS });
    expect(report.status).toBe("preflight-blocked");
    expect(report.preflight.blocking).toEqual([
      expect.objectContaining({ code: "dns.record-conflict", message: expect.stringContaining(ADMIN_HOST), operatorAction: expect.stringContaining("admin.hostname") }),
    ]);
  });

  it("adds the admin to an existing install as creates only, and reports a changed admin as drift", async () => {
    const golden = await goldenRelease();
    const { fake, options, run } = setup();
    expect((await run(golden, { admin: { enabled: false } })).status).toBe("applied");

    const drift = await dryRunDrift(options(golden), golden.sha256);
    expect(drift.ready).toBe(true);
    expect(drift.changes.map((c) => [c.resource, c.action])).toEqual([
      [`d1:${ADMIN}:DB`, "create"],
      ["access:application:admin", "create"],
      ["access:application:admin:bypass", "create"],
      [`worker:${ADMIN}`, "create"],
      [`secret:${ADMIN}:ADMIN_KEY_ENCRYPTION_KEY`, "create"],
      ["domain:admin", "create"],
    ]);
    expect(drift.pendingMigrations).toEqual(["0001_initial", "0002_control_plane"]);
    expect((await run(golden)).status).toBe("applied");

    // A release with new admin code and a new migration changes the admin alone.
    const next = await deriveRelease(golden, "r000001-fixture", async (m, a) => {
      await replaceModule(m, a, ADMIN, "export default {}; // admin r1\n");
      const sql = new TextEncoder().encode("CREATE TABLE notes (id TEXT PRIMARY KEY);\n");
      const sha256 = await a.addBlob(sql);
      m.workers[ADMIN]!.d1Migrations!.push({ binding: "DB", id: "0003_notes", sha256, size: sql.byteLength, r2Key: `blobs/modules/${sha256}` });
    });
    const changed = await dryRunDrift(options(next), next.sha256);
    expect(changed.pendingMigrations).toEqual(["0003_notes"]);
    expect(changed.changes.filter((c) => c.resource.includes("admin"))).toEqual([
      expect.objectContaining({ resource: `d1:${ADMIN}:DB`, action: "update" }),
      expect.objectContaining({ resource: `worker:${ADMIN}`, action: "update" }),
    ]);
    expect((await run(next)).status).toBe("applied");
    expect(fake.worker(SCRIPT)!.releaseId).toBe("r000001-fixture");
    expect(fake.d1Statements("educateos-northfield-admin-db").join("\n")).toContain("CREATE TABLE notes");
  });

  it("rolls the admin back to its previous version, and leaves it running on a rollback to a release without it", async () => {
    const golden = await goldenRelease();
    const next = await deriveRelease(golden, "r000001-fixture", (m, a) => replaceModule(m, a, ADMIN, "export default {}; // admin r1\n"));
    const { fake, api, run } = setup();
    expect((await run(golden)).status).toBe("applied");
    expect((await run(next)).status).toBe("applied");
    const key = fake.secretValue(SCRIPT, "ADMIN_KEY_ENCRYPTION_KEY");

    const done = await rollback({ api, config: adminConfig(next), current: next.manifest, previous: golden.manifest });
    expect(done.plan.blocked).toEqual([]);
    expect(done.plan.steps).toContainEqual(expect.objectContaining({ scriptName: SCRIPT, action: "deploy-version" }));
    expect(fake.worker(SCRIPT)!.releaseId).toBe(golden.manifest.releaseId);
    expect(fake.worker(SCRIPT)!.secretNames).toEqual(["ADMIN_KEY_ENCRYPTION_KEY"]);
    expect(fake.secretValue(SCRIPT, "ADMIN_KEY_ENCRYPTION_KEY")).toBe(key);

    // A previous release that predates the admin: the admin is new in this one, and stays.
    const older = await deriveRelease(golden, "r000000-older", (m) => {
      delete m.workers[ADMIN];
    });
    const plan = await rollback({ api, config: adminConfig(next), current: next.manifest, previous: older.manifest, dryRun: true });
    expect(plan.plan.steps.some((s) => s.scriptName === SCRIPT)).toBe(false);
    expect(plan.plan.irreversible).toContain(`${SCRIPT} is new in r000001-fixture; rollback leaves it running`);
  });
});
