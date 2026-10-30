// One origin per district (ADR-0014, SCHO-259): an install that includes the district service puts
// the district at the root of its hostname, behind the router, with the Workshop under /ai, one
// Access application, and a bypass application for the paths that check their own credential.
import { describe, expect, it } from "vitest";
import {
  ACCESS_BYPASS_PATHS,
  ACCESS_PAIRING_BROWSER_PATHS,
  compileDesiredState,
  type DesiredAccessApplication,
  type DesiredAccessPolicy,
  type DesiredWorker,
  type DesiredWorkerSecret,
  dryRunDrift,
  install,
  rollback,
} from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  mutations,
  NORTHFIELD,
  replaceModule,
  SECRETS,
  type TestRelease,
  tokenFor,
} from "./support.ts";

const DISTRICT = "educateos-district-worker";
const HOST = "educateos.northfield.example";
const SCRIPTS = {
  router: "educateos-northfield-router",
  backend: "educateos-northfield-workshop-backend",
  district: "educateos-northfield-educateos-district-worker",
};
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: "the district's own config, opaque to the installer" }) };
/** Before one origin, the operator supplies the district's Access pair. */
const LEGACY = {
  services: { [DISTRICT]: { enabled: true, vars: { ...DISTRICT_VARS, CF_ACCESS_ISS: "https://northfield.cloudflareaccess.com", CF_ACCESS_AUD: "aud-district" } } },
};

type ConfigOverrides = Record<string, unknown>;

function districtConfig(release: TestRelease, overrides: ConfigOverrides = {}) {
  return configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } }, ...overrides });
}

function compile(release: TestRelease, overrides: ConfigOverrides = {}) {
  const desired = compileDesiredState(release.manifest, districtConfig(release, overrides));
  const byKey = new Map(desired.resources.map((r) => [r.key, r]));
  return {
    desired,
    order: desired.resources.map((r) => r.key),
    worker: (pkg: string) => byKey.get(`worker:${pkg}`) as DesiredWorker,
    app: (key: string) => byKey.get(key) as DesiredAccessApplication | undefined,
    policy: (key: string) => byKey.get(key) as DesiredAccessPolicy | undefined,
    secret: (key: string) => byKey.get(key) as DesiredWorkerSecret | undefined,
  };
}

const binding = (worker: { bindings: { name: string }[] } | undefined, name: string) => worker?.bindings.find((b) => b.name === name);
/** A plain-text binding's value, parsed as JSON. */
const jsonVar = (worker: { bindings: { name: string }[] } | undefined, name: string): unknown =>
  JSON.parse(String((binding(worker, name) as { text?: unknown } | undefined)?.text));

/** The golden release as a release from before ADR-0014, which carries no one-origin wiring. */
async function legacyRelease(base: TestRelease, releaseId = "r000000-legacy") {
  return await deriveRelease(base, releaseId, (m) => {
    delete m.workers.router!.districtOrigin;
  });
}

function setup() {
  const fake = accountFor(NORTHFIELD);
  const { tokens } = tokenFor(fake, "district-run");
  const api = fake.api(tokens);
  const options = (release: TestRelease, overrides: ConfigOverrides = {}) => ({
    api,
    config: districtConfig(release, overrides),
    manifest: release.manifest,
    artifacts: release.artifacts,
    secrets: SECRETS,
  });
  const run = (release: TestRelease, overrides: ConfigOverrides = {}) => install(options(release, overrides));
  return { fake, api, run, options };
}

describe("one-origin desired state", () => {
  it("binds the router to the district, serves the Workshop built for /ai, and runs the router first for every path", async () => {
    const release = await goldenRelease();
    const { worker, order } = compile(release);

    const router = worker("router");
    expect(binding(router, "DISTRICT")).toEqual({ type: "service", name: "DISTRICT", service: SCRIPTS.district });
    expect(router.dependsOn).toContain(`worker:${DISTRICT}`);
    expect(router.assets?.config).toEqual({ not_found_handling: "single-page-application", run_worker_first: true });
    expect(router.assets?.manifest).toEqual(release.manifest.workers.router!.assetsConfig!.variants["access-ai"]!.manifest);
    expect(binding(router, "AI_ENABLED")).toBeUndefined();
    expect(binding(worker("workshop-backend"), "PUBLIC_BASE_PATH")).toEqual({ type: "plain_text", name: "PUBLIC_BASE_PATH", text: "/ai" });
    expect(order.indexOf(`worker:${DISTRICT}`)).toBeLessThan(order.indexOf("worker:router"));
  });

  it("gives the district the one application's issuer and audience, its school manifest and a generated device key", async () => {
    const release = await goldenRelease();
    const { worker, secret, desired } = compile(release);
    const district = worker(DISTRICT);
    expect(binding(district, "CF_ACCESS_ISS")).toEqual({ type: "plain_text", name: "CF_ACCESS_ISS", text: "https://northfield.cloudflareaccess.com" });
    expect(binding(district, "CF_ACCESS_AUD")).toEqual({ type: "plain_text", name: "CF_ACCESS_AUD", text: { ref: "access:application", output: "aud" } });
    expect(district.dependsOn).toContain("access:application");
    expect(jsonVar(district, "SCHOOL_MANIFEST"))
      .toEqual({ origin: `https://${HOST}`, features: { ai: true } });
    expect(binding(district, "DISTRICT_CONFIG")).toEqual({ type: "plain_text", name: "DISTRICT_CONFIG", text: DISTRICT_VARS.DISTRICT_CONFIG });
    expect(secret(`secret:${DISTRICT}:DEVICE_TOKEN_SECRET`)).toMatchObject({ scriptName: SCRIPTS.district, generated: true });
    // The operator is asked for neither the Access pair nor the generated key.
    expect(desired.inputs.filter((i) => i.pkgName === DISTRICT).map((i) => [i.name, i.kind === "secret" && i.generated]))
      .toEqual([["DISTRICT_CONFIG", false], ["DEVICE_TOKEN_SECRET", true]]);
  });

  it("exempts the self-authenticating paths from Access and keeps the pairing browser endpoints behind it, on every hostname", async () => {
    const release = await goldenRelease();
    const { app, policy, order } = compile(release, { managedHostname: { slug: "northfield" } });
    const hosts = [HOST, "northfield.educateos.io"];

    expect(app("access:application")?.destinations).toEqual([
      ...hosts,
      ...ACCESS_PAIRING_BROWSER_PATHS.flatMap((path) => hosts.map((host) => host + path)),
    ]);
    expect(app("access:application")?.destinations).toContain(`${HOST}/api/pair/rooms/*/approve`);

    const bypass = app("access:application:bypass")!;
    expect(bypass).toMatchObject({ name: "educateos-northfield-bypass", domain: `${HOST}/healthz`, policyKey: "access:policy:bypass" });
    expect(bypass.destinations.toSorted()).toEqual(hosts.flatMap((host) => [
      "/healthz", "/.well-known/educateos.json", "/lti/*", "/api/m/*", "/api/pair/*", "/api/pair/rooms/*", "/api/ops/*",
    ].map((path) => host + path)).toSorted());
    expect(ACCESS_BYPASS_PATHS).toHaveLength(7);
    expect(policy("access:policy:bypass")?.spec).toEqual({ name: "educateos-northfield-bypass", decision: "bypass", include: [{ everyone: {} }] });
    // The members policy is unchanged.
    expect(policy("access:policy")?.spec).toMatchObject({ decision: "allow", include: [{ email_domain: { domain: "northfield.example" } }] });

    // The bypass is in place before either hostname serves.
    expect(order.indexOf("access:application:bypass")).toBeLessThan(order.indexOf("domain:public"));
    expect(order.indexOf("access:application:bypass")).toBeLessThan(order.indexOf("domain:managed"));
  });

  it("turns AI off: the router serves the not-enabled page linking to the demo, and the manifest says so", async () => {
    const release = await goldenRelease();
    const { worker } = compile(release, { ai: { enabled: false, demoUrl: "https://northfield.educateos.io/ai/" } });
    expect(binding(worker("router"), "AI_ENABLED")).toEqual({ type: "plain_text", name: "AI_ENABLED", text: "false" });
    expect(binding(worker("router"), "AI_DEMO_URL")).toEqual({ type: "plain_text", name: "AI_DEMO_URL", text: "https://northfield.educateos.io/ai/" });
    expect(jsonVar(worker(DISTRICT), "SCHOOL_MANIFEST")).toMatchObject({ features: { ai: false } });
    // The Workshop's Workers stay: the district's services are bound through the backend.
    expect(worker("workshop-backend")).toBeDefined();
    expect(binding(worker("router"), "WORKSHOP_BACKEND")).toBeDefined();
    expect(binding(compile(release, { ai: { enabled: false } }).worker("router"), "AI_DEMO_URL")).toBeUndefined();
  });

  it("refuses AI off without the district, Access values the installer sets, and a non-https demo URL", async () => {
    const release = await goldenRelease();
    expect(() => compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { ai: { enabled: false } })))
      .toThrow(/AI can be turned off only on a one-origin install/);
    expect(() => compile(release, { services: { [DISTRICT]: { enabled: true, vars: { ...DISTRICT_VARS, CF_ACCESS_AUD: "aud" } } } }))
      .toThrow(/the installer sets CF_ACCESS_AUD on a one-origin install/);
    expect(() => compile(release, { ai: { enabled: false, demoUrl: "http://demo.example" } })).toThrow();
  });

  it("leaves an install without the district, or a release from before one origin, as it was", async () => {
    const release = await goldenRelease();
    const plain = compileDesiredState(release.manifest, configFor(NORTHFIELD, release));
    const legacy = await legacyRelease(release);
    const old = compileDesiredState(legacy.manifest, districtConfig(legacy, LEGACY));
    for (const desired of [plain, old]) {
      const router = desired.resources.find((r): r is DesiredWorker => r.kind === "worker_script" && r.role === "router")!;
      expect(binding(router, "DISTRICT")).toBeUndefined();
      expect(router.assets?.config.run_worker_first).toEqual(release.manifest.workers.router!.assetsConfig!.run_worker_first);
      expect(router.assets?.manifest).toEqual(release.manifest.workers.router!.assetsConfig!.variants.access!.manifest);
      expect(desired.resources.some((r) => r.key.startsWith("access:") && r.key.endsWith(":bypass"))).toBe(false);
      const app = desired.resources.find((r) => r.key === "access:application") as DesiredAccessApplication;
      expect(app.destinations).toEqual([HOST]);
      const backend = desired.resources.find((r): r is DesiredWorker => r.key === "worker:workshop-backend")!;
      expect(binding(backend, "PUBLIC_BASE_PATH")).toBeUndefined();
    }
    // Before one origin, the operator supplies the district's Access pair, as before.
    expect(old.inputs.filter((i) => i.pkgName === DISTRICT).map((i) => i.name)).toEqual(["DISTRICT_CONFIG", "CF_ACCESS_ISS", "CF_ACCESS_AUD", "DEVICE_TOKEN_SECRET"]);
  });
});

describe("one-origin install", () => {
  it("installs the district behind the router with a generated device key, and a second run changes nothing", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    const report = await run(release);
    expect(report.status).toBe("applied");
    expect(report.preflight.blocking).toEqual([]);

    const router = fake.worker(SCRIPTS.router)!;
    expect(binding(router, "DISTRICT")).toMatchObject({ type: "service", service: SCRIPTS.district });
    expect(router.assetsConfig).toEqual({ not_found_handling: "single-page-application", run_worker_first: true });
    expect(fake.serving(HOST)?.scriptName).toBe(SCRIPTS.router);

    const district = fake.worker(SCRIPTS.district)!;
    expect(district.secretNames).toEqual(["DEVICE_TOKEN_SECRET"]);
    const key = fake.secretValue(SCRIPTS.district, "DEVICE_TOKEN_SECRET")!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The district accepts exactly the one application's audience.
    expect(binding(district, "CF_ACCESS_AUD")).toMatchObject({ text: fake.accessApplication("educateos-northfield")!.aud });
    expect(fake.accessApplication("educateos-northfield-bypass")?.destinations).toContain(`${HOST}/api/m/*`);
    // No plan or report carries the generated value.
    expect(JSON.stringify(report)).not.toContain(key);

    const again = await run(release);
    expect(again.status).toBe("applied");
    expect(again.plan!.steps.filter((s) => s.action !== "noop")).toEqual([]);
    expect(fake.secretValue(SCRIPTS.district, "DEVICE_TOKEN_SECRET")).toBe(key);
  });

  it("uses a supplied device key instead of generating one", async () => {
    const release = await goldenRelease();
    const { fake, api } = setup();
    const supplied = "a-district-chosen-device-token-key-of-enough-length";
    const report = await install({
      api,
      config: districtConfig(release),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: { get: (pkg, name) => (pkg === DISTRICT && name === "DEVICE_TOKEN_SECRET" ? supplied : SECRETS.get(pkg, name)) },
    });
    expect(report.status).toBe("applied");
    expect(fake.secretValue(SCRIPTS.district, "DEVICE_TOKEN_SECRET")).toBe(supplied);
  });

  it("plans the move of an existing install to one origin, and repairs a removed DISTRICT binding as drift", async () => {
    const golden = await goldenRelease();
    const legacy = await legacyRelease(golden);
    const { fake, options, run } = setup();
    expect((await run(legacy, LEGACY)).status).toBe("applied");
    expect(binding(fake.worker(SCRIPTS.router), "DISTRICT")).toBeUndefined();

    const drift = await dryRunDrift(options(golden), golden.sha256);
    expect(drift.ready).toBe(true);
    const changes = new Map(drift.changes.map((c) => [c.resource, c]));
    expect(changes.get("access:policy:bypass")?.action).toBe("create");
    expect(changes.get("access:application:bypass")?.action).toBe("create");
    expect(changes.get("access:application")).toMatchObject({ action: "update", reason: "hostnames or policy differ" });
    expect(changes.get("worker:router")).toMatchObject({ action: "update", reason: expect.stringContaining(`binds DISTRICT to ${SCRIPTS.district}`) });

    expect((await run(golden)).status).toBe("applied");
    fake.editWorkerBindings(SCRIPTS.router, (bindings) => bindings.filter((b) => b.name !== "DISTRICT"));
    const removed = await dryRunDrift(options(golden), golden.sha256);
    expect(removed.changes).toEqual([
      expect.objectContaining({ resource: "worker:router", action: "update", reason: `drift: binds DISTRICT to ${SCRIPTS.district}` }),
    ]);
    expect((await run(golden)).status).toBe("applied");
    expect(binding(fake.worker(SCRIPTS.router), "DISTRICT")).toBeDefined();
  });

  it("rolls the router back to its version from before one origin", async () => {
    const golden = await goldenRelease();
    const legacy = await legacyRelease(golden);
    const next = await deriveRelease(golden, "r000001-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r1\n"));
    const { fake, api, run } = setup();
    expect((await run(legacy, LEGACY)).status).toBe("applied");
    expect((await run(next)).status).toBe("applied");
    expect(binding(fake.worker(SCRIPTS.router), "DISTRICT")).toBeDefined();
    const before = mutations(fake).length;

    const done = await rollback({ api, config: districtConfig(next), current: next.manifest, previous: legacy.manifest });
    expect(done.plan.blocked).toEqual([]);
    expect(mutations(fake).length).toBeGreaterThan(before);
    expect(fake.worker(SCRIPTS.router)!.releaseId).toBe(legacy.manifest.releaseId);
    expect(binding(fake.worker(SCRIPTS.router), "DISTRICT")).toBeUndefined();
    // The device key survives: secrets are kept across versions.
    expect(fake.worker(SCRIPTS.district)!.secretNames).toEqual(["DEVICE_TOKEN_SECRET"]);
  });
});
