// A managed-only district (SCHO-243): no zone of its own, so `<slug>.educateos.io` is its public
// hostname and identity, the origin the router, Access, the school manifest and $PUBLIC_BASE_URL all
// use. It works only where educateos.io is a zone in the district's account (the owner's hosted
// districts); a district in another account is refused before anything changes.
import { describe, expect, it } from "vitest";
import {
  ACCESS_BYPASS_PATHS,
  ACCESS_PAIRING_BROWSER_PATHS,
  compileDesiredState,
  type DesiredAccessApplication,
  type DesiredManagedHostname,
  type DesiredWorker,
  DistrictInstallConfig,
  install,
  planInstall,
} from "../src/index.ts";
import { accountFor, configFor, goldenRelease, mutations, NORTHFIELD, SECRETS, type TestRelease, tokenFor } from "./support.ts";

const DISTRICT = "educateos-district-worker";
const HOST = "northfield.educateos.io";
const ROUTER = "educateos-northfield-router";
const DISTRICT_SCRIPT = "educateos-northfield-educateos-district-worker";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: true }) };

function managedOnlyConfig(release: TestRelease, overrides: Record<string, unknown> = {}) {
  return configFor(NORTHFIELD, release, {
    baseDomain: undefined,
    managedHostname: { slug: "northfield" },
    services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } },
    ...overrides,
  });
}

/** An account like the owner's: educateos.io is one of its zones, and the district has none. */
function hostedAccount() {
  const fake = accountFor(NORTHFIELD, { zones: [{ name: "educateos.io" }] });
  return { fake, api: fake.api(tokenFor(fake, "district-run").tokens) };
}

const text = (worker: { bindings: { name: string }[] } | undefined, name: string) =>
  (worker?.bindings.find((b) => b.name === name) as { text?: unknown } | undefined)?.text;

describe("managed-only install config", () => {
  it("needs a base domain, a managed hostname, or both", async () => {
    const release = await goldenRelease();
    expect(() => configFor(NORTHFIELD, release, { baseDomain: undefined })).toThrow(/set baseDomain, managedHostname, or both/);
    expect(DistrictInstallConfig.safeParse({ ...managedOnlyConfig(release), subdomain: "ignored" }).success).toBe(true);
  });

  it("serves the managed hostname as the public origin, with no custom domain on a district zone", async () => {
    const release = await goldenRelease();
    const desired = compileDesiredState(release.manifest, managedOnlyConfig(release));
    const byKey = new Map(desired.resources.map((r) => [r.key, r]));

    expect(desired.hostname).toBe(HOST);
    expect(byKey.has("domain:public")).toBe(false);
    expect(byKey.get("domain:managed")).toMatchObject({ hostname: HOST, scriptName: ROUTER, zoneName: null, phase: "attach" } satisfies Partial<DesiredManagedHostname>);
    const app = byKey.get("access:application") as DesiredAccessApplication;
    expect(app.domain).toBe(HOST);
    // One hostname, listed once: the managed hostname is not also an alias.
    expect(app.destinations).toEqual([HOST, ...ACCESS_PAIRING_BROWSER_PATHS.map((path) => HOST + path)]);
    expect((byKey.get("access:application:bypass") as DesiredAccessApplication).destinations).toEqual(ACCESS_BYPASS_PATHS.map((path) => HOST + path));
    const district = byKey.get(`worker:${DISTRICT}`) as DesiredWorker;
    expect(JSON.parse(String(text(district, "SCHOOL_MANIFEST")))).toMatchObject({ origin: `https://${HOST}` });
    // $PUBLIC_BASE_URL resolves to the managed origin wherever the release uses it.
    const publicUrls = desired.resources.flatMap((r) => (r.kind === "worker_script" ? r.bindings : []))
      .flatMap((b) => (typeof b.text === "string" && b.text.startsWith("https://") && b.text.includes("educateos") ? [b.text] : []));
    expect(publicUrls.every((url) => url.startsWith(`https://${HOST}`))).toBe(true);
    // The attach waits for both Access applications, as an alias's does.
    const order = desired.resources.map((r) => r.key);
    expect(order.indexOf("access:application:bypass")).toBeLessThan(order.indexOf("domain:managed"));
    expect(order.indexOf("access:application")).toBeLessThan(order.indexOf("domain:managed"));
  });

  it("refuses the OSS admin, which needs a zone of the district's own", async () => {
    const release = await goldenRelease();
    expect(() => compileDesiredState(release.manifest, managedOnlyConfig(release, { admin: { enabled: true } })))
      .toThrow(/a managed-only install \(no baseDomain\) can't have it yet/);
    expect(() => compileDesiredState(release.manifest, managedOnlyConfig(release, { admin: { enabled: true, hostname: "admin.northfield.example" } })))
      .toThrow(/managed-only/);
  });
});

describe("managed-only install", () => {
  it("installs at the managed hostname in an account that holds educateos.io, never serving it without Access", async () => {
    const release = await goldenRelease();
    const { fake, api } = hostedAccount();
    fake.beforeMutation = () => {
      if (fake.serving(HOST)) expect(fake.accessApplication("educateos-northfield-bypass")?.destinations).toContain(`${HOST}/lti/*`);
    };
    const options = { api, config: managedOnlyConfig(release), manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS };

    const report = await install(options);

    expect(report.preflight.blocking).toEqual([]);
    expect(report.status).toBe("applied");
    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
    expect(fake.accessApplication("educateos-northfield")?.destinations[0]).toBe(HOST);
    expect(JSON.parse(String(text(fake.worker(DISTRICT_SCRIPT), "SCHOOL_MANIFEST")))).toMatchObject({ origin: `https://${HOST}` });
    expect(fake.calls.some((c) => c.operation === "listDnsRecords" && c.outcome === "ok")).toBe(true);

    const again = await install(options);
    expect(again.plan!.steps.filter((s) => s.action !== "noop")).toEqual([]);
  });

  it("refuses a district in another account before changing anything", async () => {
    const release = await goldenRelease();
    // The district's own account: a zone of its own, but not educateos.io, and no baseDomain set.
    const fake = accountFor(NORTHFIELD);
    const api = fake.api(tokenFor(fake, "district-run").tokens);
    const config = managedOnlyConfig(release);

    const report = await install({ api, config, manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS });
    expect(report.status).toBe("preflight-blocked");
    expect(report.preflight.blocking).toEqual([expect.objectContaining({
      code: "dns.managed-only-cross-account",
      operatorAction: expect.stringContaining("Set baseDomain"),
    })]);
    expect(mutations(fake)).toHaveLength(0);

    // The plan refuses it too, so an apply that skipped preflight could not start either.
    const plan = await planInstall(api, compileDesiredState(release.manifest, config), SECRETS);
    expect(plan.blocked).toEqual([expect.objectContaining({ key: "domain:managed", action: "refuse", reason: expect.stringContaining("set baseDomain") })]);
  });

  it("refuses a managed hostname another Worker holds, as for an alias", async () => {
    const release = await goldenRelease();
    const { fake, api } = hostedAccount();
    fake.seedWorker("someone-else");
    fake.seedWorkerDomain(HOST, "someone-else");

    const report = await install({ api, config: managedOnlyConfig(release), manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS });
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked).toEqual([expect.objectContaining({ key: "domain:managed", reason: `${HOST} routes to Worker someone-else: the slug is taken` })]);
  });
});
