import { describe, expect, it } from "vitest";
import {
  applyManagedZone,
  type CloudflareApi,
  CloudflareApiError,
  DistrictInstallConfig,
  DistrictSlug,
  FakeCloudflare,
  install,
  managedHostnameRecords,
  type ManagedZoneClaim,
  originHostname,
  ownerComment,
  planManagedZone,
  RESERVED_SLUGS,
} from "../src/index.ts";
import { accountFor, configFor, goldenRelease, mutations, NORTHFIELD, SECRETS, tokenFor } from "./support.ts";

const HOST = "northfield.educateos.io";
const PUBLIC = "educateos.northfield.example";
const ROUTER = "educateos-northfield-router";

type Release = Awaited<ReturnType<typeof goldenRelease>>;

/** The fake's port with some operations replaced, as a narrower token or a different account would answer. */
function withApi(fake: FakeCloudflare, override: (api: CloudflareApi) => Partial<CloudflareApi>): CloudflareApi {
  const api = fake.api(tokenFor(fake, "district-run").tokens);
  const replaced = override(api);
  return new Proxy(api, {
    get: (target, key) => {
      const value = (replaced as Record<PropertyKey, unknown>)[key] ?? Reflect.get(target, key, target);
      // The fake's methods use private fields, so they must run on the fake itself, not the proxy.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function installWith(fake: FakeCloudflare, release: Release, slug: string | undefined, api?: CloudflareApi) {
  const { tokens } = tokenFor(fake, "district-run");
  return await install({
    api: api ?? fake.api(tokens),
    config: configFor(NORTHFIELD, release, slug ? { managedHostname: { slug } } : {}),
    manifest: release.manifest,
    artifacts: release.artifacts,
    secrets: SECRETS,
  });
}

/** educateos.io's own account, which holds the managed zone. */
function managedAccount() {
  const fake = new FakeCloudflare({ accountId: "e0".repeat(16), accessTeam: null, zones: [{ name: "educateos.io" }] });
  return { fake, api: fake.api(tokenFor(fake, "district-run").tokens), zoneId: "zone-0" };
}

const ORIGIN = originHostname("northfield.example");

/**
 * Checks, before every mutation and once at the end, that each managed hostname the account serves
 * is listed by the instance's Access application: an alias is never served without Access.
 */
function guardAccess(fake: FakeCloudflare, hostnames: string[]) {
  const check = () => {
    const destinations = fake.accessApplication("educateos-northfield")?.destinations ?? [];
    for (const hostname of hostnames) {
      if (fake.serving(hostname)) expect(destinations, `${hostname} served without Access`).toContain(hostname);
    }
  };
  fake.beforeMutation = check;
  return check;
}

/** The TXT values the managed zone publishes, as the district's validation checks would read them. */
function txtIn(fake: FakeCloudflare) {
  return (name: string) => fake.dnsRecords().filter((r) => r.type === "TXT" && r.name === name).map((r) => r.content);
}

describe("district slugs", () => {
  it("accepts DNS-safe labels and refuses reserved, malformed and IDN ones", () => {
    for (const slug of ["northfield", "nf2", "lake-county-k12"]) expect(DistrictSlug.safeParse(slug).success).toBe(true);
    for (const slug of ["www", "api", "app", "admin", "demo", "docs", "mail", "educateos"]) {
      expect(RESERVED_SLUGS.has(slug)).toBe(true);
      expect(DistrictSlug.safeParse(slug).success).toBe(false);
    }
    expect(RESERVED_SLUGS.has("schoolos")).toBe(true); // rename-educateos: keep
    for (const slug of ["nf", "a".repeat(33), "2northfield", "north_field", "Northfield", "north--field", "xn--nrthfeld-n4a", "northfield-", "north.field", ""]) {
      expect(DistrictSlug.safeParse(slug).success, slug).toBe(false);
    }
  });

  it("refuses a reserved slug in the install config", async () => {
    const release = await goldenRelease();
    expect(() => configFor(NORTHFIELD, release, { managedHostname: { slug: "admin" } })).toThrow(/reserved/);
    // A public hostname under the managed zone would read as a managed hostname, and be released.
    expect(() => configFor(NORTHFIELD, release, { baseDomain: "educateos.io" })).toThrow(/own domain/);
    expect(() => configFor(NORTHFIELD, release, { baseDomain: "nf.educateos.io" })).toThrow(/own domain/);
    expect(DistrictInstallConfig.safeParse({ ...configFor(NORTHFIELD, release), managedHostname: { slug: "nf", extra: 1 } }).success).toBe(false);
  });
});

describe("managed hostname, same account (the demo)", () => {
  const sameAccount = () => accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });

  it("attaches <slug>.educateos.io beside the public hostname, behind the same Access application", async () => {
    const release = await goldenRelease();
    const fake = sameAccount();

    expect((await installWith(fake, release, "northfield")).status).toBe("applied");

    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
    expect(fake.serving(PUBLIC)?.scriptName).toBe(ROUTER);
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC, HOST]);
    expect(fake.inventory()).toMatchObject({ domains: 2, accessApplications: 1, customHostnames: 0, workerRoutes: 0 });
    // The alias is routing only: the backend's identity is still the public hostname.
    const vars = fake.worker("educateos-northfield-workshop-backend")!.bindings.filter((b) => b.name === "PUBLIC_BASE_URL");
    expect(vars.map((b) => b.text)).toEqual([`https://${PUBLIC}`]);

    const before = mutations(fake).length;
    expect((await installWith(fake, release, "northfield")).status).toBe("applied");
    expect(mutations(fake)).toHaveLength(before);
  });

  it("keeps the Access audience when the alias is added to an existing install", async () => {
    const release = await goldenRelease();
    const fake = sameAccount();
    await installWith(fake, release, undefined);
    const { aud } = fake.accessApplication("educateos-northfield")!;

    await installWith(fake, release, "northfield");

    expect(fake.accessApplication("educateos-northfield")).toEqual({ destinations: [PUBLIC, HOST], aud });
  });

  it("refuses, before any change, a slug another Worker or record already holds", async () => {
    const release = await goldenRelease();
    const taken = sameAccount();
    taken.seedWorker("someone-else");
    taken.seedWorkerDomain(HOST, "someone-else");
    const report = await installWith(taken, release, "northfield");
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual([`${HOST} routes to Worker someone-else: the slug is taken`]);
    expect(mutations(taken)).toHaveLength(0);

    const recorded = accountFor(NORTHFIELD, {
      zones: [{ name: "northfield.example" }, { name: "educateos.io" }],
      dnsRecords: [{ name: HOST, type: "CNAME", content: "elsewhere.example" }],
    });
    expect((await installWith(recorded, release, "northfield")).plan!.blocked[0]!.reason).toMatch(/already has DNS records \(CNAME\)/);
  });

  it("moves to a new slug, and releases the alias before the Access application drops it", async () => {
    const release = await goldenRelease();
    const fake = sameAccount();
    const check = guardAccess(fake, [HOST, "nf-schools.educateos.io"]);
    await installWith(fake, release, "northfield");

    let start = fake.calls.length;
    await installWith(fake, release, "nf-schools");
    expect(fake.calls.slice(start).filter((c) => c.mutation).map((c) => c.operation))
      .toEqual(["detachWorkerDomain", "updateAccessApplication", "attachWorkerDomain"]);
    check();
    expect(fake.serving(HOST)).toBeUndefined();
    expect(fake.serving("nf-schools.educateos.io")?.scriptName).toBe(ROUTER);

    start = fake.calls.length;
    expect((await installWith(fake, release, undefined)).status).toBe("applied");
    const changes = fake.calls.slice(start).filter((c) => c.mutation).map((c) => c.operation);
    expect(changes).toEqual(["detachWorkerDomain", "updateAccessApplication"]);
    check();
    expect(fake.serving("nf-schools.educateos.io")).toBeUndefined();
    expect(fake.serving(PUBLIC)?.scriptName).toBe(ROUTER);
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC]);
  });
});

describe("managed hostname, cross account (Cloudflare for SaaS on the district's zone)", () => {
  const district = () => accountFor(NORTHFIELD, { saasZones: ["northfield.example"] });

  /** Installs, publishes the records in the managed zone, and lets the district's checks run. */
  async function attach(fake: FakeCloudflare, managed: ReturnType<typeof managedAccount>, release: Release) {
    expect((await installWith(fake, release, "northfield")).status).toBe("applied");
    const records = await managedHostnameRecords(fake.api(tokenFor(fake, "district-run").tokens), "zone-0", HOST);
    expect(records).toBeDefined();
    const claim: ManagedZoneClaim = { zoneId: managed.zoneId, instanceId: "ins_northfield", hostname: HOST, records: records! };
    await applyManagedZone(managed.api, await planManagedZone(managed.api, claim));
    fake.validateCustomHostnames(txtIn(managed.fake));
    return claim;
  }

  it("serves through the district's own zone, with educateos.io publishing DNS only", async () => {
    const release = await goldenRelease();
    const fake = district();
    const managed = managedAccount();

    expect((await installWith(fake, release, "northfield")).status).toBe("applied");
    // Not yet validated, so not yet served.
    expect(fake.serving(HOST)).toBeUndefined();
    expect(fake.inventory()).toMatchObject({ domains: 1, customHostnames: 1, workerRoutes: 1 });
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC, HOST]);

    await attach(fake, managed, release);

    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
    // educateos.io answers DNS and nothing else: the CNAME is DNS-only, every record carries its
    // owner, and no Worker in educateos.io's account is on the path, so the site Worker being
    // down cannot affect the district.
    const published = managed.fake.dnsRecords();
    expect(published.map((r) => [r.type, r.name, r.proxied, r.comment]).toSorted()).toEqual([
      ["CNAME", HOST, false, ownerComment("ins_northfield")],
      ["TXT", `_acme-challenge.${HOST}`, false, ownerComment("ins_northfield")],
      ["TXT", `_cf-custom-hostname.${HOST}`, false, ownerComment("ins_northfield")],
    ]);
    // The CNAME target is the district's originless fallback origin, which the installer owns.
    expect(published.find((r) => r.type === "CNAME")!.content).toBe(ORIGIN);
    expect(fake.dnsRecords().filter((r) => r.name === ORIGIN)).toEqual([
      expect.objectContaining({ type: "AAAA", content: "100::", proxied: true, comment: ownerComment("ins_northfield") }),
    ]);
    expect(managed.fake.serving(HOST)).toBeUndefined();
    expect(managed.fake.inventory()).toMatchObject({ workers: 0, domains: 0, workerRoutes: 0 });

    const before = { district: mutations(fake).length, managed: mutations(managed.fake).length };
    expect((await installWith(fake, release, "northfield")).plan!.steps.find((s) => s.key === "domain:managed")!.reason)
      .toBe("custom hostname active");
    expect(mutations(fake)).toHaveLength(before.district);
  });

  it("asks for Cloudflare for SaaS rather than half-attaching without it", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const report = await installWith(fake, release, "northfield");
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual([expect.stringMatching(/^enable Cloudflare for SaaS on northfield\.example/)]);
    expect(mutations(fake)).toHaveLength(0);
  });

  it("refuses a route for the hostname that runs another Worker", async () => {
    const release = await goldenRelease();
    const fake = district();
    fake.seedWorker("someone-else");
    fake.seedWorkerRoute("northfield.example", `${HOST}/*`, "someone-else");
    const report = await installWith(fake, release, "northfield");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual([`route ${HOST}/* runs someone-else, not ${ROUTER}`]);
  });

  it("moves to a new slug without ever serving an alias outside Access", async () => {
    const release = await goldenRelease();
    const fake = district();
    const managed = managedAccount();
    await attach(fake, managed, release);
    const check = guardAccess(fake, [HOST, "nf-schools.educateos.io"]);

    const start = fake.calls.length;
    expect((await installWith(fake, release, "nf-schools")).status).toBe("applied");
    expect(fake.calls.slice(start).filter((c) => c.mutation).map((c) => c.operation))
      .toEqual(["deleteCustomHostname", "deleteWorkerRoute", "updateAccessApplication", "createWorkerRoute", "createCustomHostname"]);
    check();
    expect(fake.inventory()).toMatchObject({ customHostnames: 1, workerRoutes: 1 });
  });

  it("finishes an interrupted release on the next run, leaving no custom hostname behind", async () => {
    const release = await goldenRelease();
    const fake = district();
    const managed = managedAccount();
    await attach(fake, managed, release);
    const check = guardAccess(fake, [HOST]);

    // The custom hostname is deleted, then the run stops before the route goes.
    fake.interruptMutation(2, { effectApplied: false });
    await expect(installWith(fake, release, undefined)).rejects.toMatchObject({ operation: "deleteWorkerRoute" });
    check();
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC, HOST]);

    expect((await installWith(fake, release, undefined)).status).toBe("applied");
    expect(fake.inventory()).toMatchObject({ customHostnames: 0, workerRoutes: 0 });
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC]);
  });

  it("leaves nothing behind when an interrupted attach is abandoned", async () => {
    const release = await goldenRelease();
    const fake = district();
    await installWith(fake, release, undefined);
    fake.interruptMutation(5, { effectApplied: false });
    await expect(installWith(fake, release, "northfield")).rejects.toMatchObject({ operation: "createCustomHostname" });
    expect(fake.inventory()).toMatchObject({ customHostnames: 0, workerRoutes: 1 });

    // The operator gives up on the alias: the route the interruption left is found and removed.
    expect((await installWith(fake, release, undefined)).status).toBe("applied");
    expect(fake.inventory()).toMatchObject({ customHostnames: 0, workerRoutes: 0 });
    expect(fake.accessApplication("educateos-northfield")!.destinations).toEqual([PUBLIC]);
  });

  it("keeps a working alias, and changes nothing, when a later token cannot see the managed zone", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
    await installWith(fake, release, "northfield");
    // A token scoped to the district's zone only: the managed zone is invisible to it.
    const blind = withApi(fake, (api) => ({ findZone: (a, name) => (name === "educateos.io" ? Promise.resolve(undefined) : api.findZone(a, name)) }));

    const before = mutations(fake).length;
    const report = await installWith(fake, release, "northfield", blind);
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual([expect.stringMatching(/^enable Cloudflare for SaaS/)]);
    expect(report.plan!.steps.find((s) => s.key === "domain:managed:release")!.action).toBe("noop");
    expect(mutations(fake)).toHaveLength(before);
    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
  });

  it("asks for SaaS quota instead of halting as if the credential failed", async () => {
    const release = await goldenRelease();
    const fake = district();
    const quotaless = withApi(fake, () => ({ findCustomHostname: () => Promise.reject(new CloudflareApiError("findCustomHostname", 403, [1404])) }));
    const report = await installWith(fake, release, "northfield", quotaless);
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked.map((s) => s.reason)).toEqual(["Cloudflare for SaaS has no custom hostname quota on northfield.example"]);
  });

  it("converges after an interrupted attach whose effect landed", async () => {
    const release = await goldenRelease();
    const fake = district();
    await installWith(fake, release, undefined);
    // The next mutations: the Access update, the origin record, the fallback origin, the route, the
    // custom hostname.
    fake.interruptMutation(5, { effectApplied: true });
    await expect(installWith(fake, release, "northfield")).rejects.toMatchObject({ operation: "createCustomHostname" });

    expect((await installWith(fake, release, "northfield")).status).toBe("applied");
    expect(fake.inventory()).toMatchObject({ customHostnames: 1, workerRoutes: 1 });
  });

  it("releases on leaving: the district removes its route and hostname, educateos.io its own records", async () => {
    const release = await goldenRelease();
    const fake = district();
    const managed = managedAccount();
    const claim = await attach(fake, managed, release);
    // Another instance's record under the same zone is never touched.
    await managed.api.createDnsRecord(managed.zoneId, { type: "CNAME", name: "riverbend.educateos.io", content: "x.example", proxied: false, comment: ownerComment("ins_riverbend") });

    const check = guardAccess(fake, [HOST]);
    const start = fake.calls.length;
    expect((await installWith(fake, release, undefined)).status).toBe("applied");
    expect(fake.calls.slice(start).filter((c) => c.mutation).map((c) => c.operation))
      .toEqual(["deleteCustomHostname", "deleteWorkerRoute", "updateAccessApplication"]);
    check();
    expect(fake.serving(HOST)).toBeUndefined();
    expect(fake.serving(PUBLIC)?.scriptName).toBe(ROUTER);
    expect(fake.inventory()).toMatchObject({ customHostnames: 0, workerRoutes: 0 });

    const release_ = await planManagedZone(managed.api, { ...claim, records: null });
    expect(release_.steps.map((s) => s.action)).toEqual(["delete", "delete", "delete"]);
    await applyManagedZone(managed.api, release_);
    expect(managed.fake.dnsRecords().map((r) => r.name)).toEqual(["riverbend.educateos.io"]);
  });
});

describe("managed zone (the educateos.io half)", () => {
  const records = { hostname: HOST, cnameTarget: PUBLIC, txt: [{ name: `_cf-custom-hostname.${HOST}`, value: "own-1" }] };

  it("refuses, before any change, a slug whose names another owner holds", async () => {
    const managed = managedAccount();
    await managed.api.createDnsRecord(managed.zoneId, { type: "CNAME", name: HOST, content: "other.example", proxied: false, comment: ownerComment("ins_other") });
    const plan = await planManagedZone(managed.api, { zoneId: managed.zoneId, instanceId: "ins_northfield", hostname: HOST, records });
    expect(plan.steps.filter((s) => s.action === "refuse").map((s) => s.action === "refuse" && s.reason))
      .toEqual([`CNAME ${HOST} is not ins_northfield's: the slug is taken`]);
    const before = mutations(managed.fake).length;
    await expect(applyManagedZone(managed.api, plan)).rejects.toMatchObject({ code: "conflict" });
    expect(mutations(managed.fake)).toHaveLength(before);
  });

  it("updates a changed record in place, removes stale ones and is idempotent", async () => {
    const managed = managedAccount();
    const claim = { zoneId: managed.zoneId, instanceId: "ins_northfield", hostname: HOST, records };
    await applyManagedZone(managed.api, await planManagedZone(managed.api, claim));
    const cnameId = managed.fake.dnsRecords().find((r) => r.type === "CNAME")!.id;

    // The district's fallback origin moved, and ownership has been validated.
    const moved = { ...claim, records: { ...records, cnameTarget: "origin.northfield.example", txt: [] } };
    const plan = await planManagedZone(managed.api, moved);
    expect(plan.steps.map((s) => s.action)).toEqual(["update", "delete"]);
    await applyManagedZone(managed.api, plan);
    expect(managed.fake.dnsRecords()).toEqual([expect.objectContaining({ id: cnameId, content: "origin.northfield.example" })]);
    expect((await planManagedZone(managed.api, moved)).steps).toEqual([]);
  });

  it("publishes only the hostname's own names", async () => {
    const managed = managedAccount();
    const claim = {
      zoneId: managed.zoneId,
      instanceId: "ins_northfield",
      hostname: HOST,
      records: { ...records, txt: [{ name: "educateos.io", value: "v=spf1 -all" }] },
    };
    await expect(planManagedZone(managed.api, claim)).rejects.toMatchObject({ code: "validation-failed" });
  });
});
