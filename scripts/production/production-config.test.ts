// The production-instance generator (scripts/production/production-config.ts), against the repo's
// REAL wrangler.jsonc files: the committed wrangler.production.jsonc files are what it generates
// today (the golden check), and the shape of an instance is asserted directly, so that a change to
// how a Worker is bound in production is a conscious one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { AI_GUARD_DEV_MAIN, AI_GUARD_PACKAGE } from "../ai-guard-dev.ts";
import { readDeployablePackages } from "../release/manifest-lib.ts";
import { PACKAGES_DIR } from "../preview/staging-config.ts";
import {
  DISTRICT_PACKAGE, PRODUCTION_CONFIG_NAME, EDUCATEOS_GATEKEEPER_PACKAGE, buildDemoDistrictConfigs, buildProductionConfigs,
  demoDistrictConfigName, demoDistrictWorkerName, generateProductionConfigs, productionBuildEnv, productionPackageNames,
  productionWorkerName, renderProductionConfig, type DemoDistrictDeployment, type ProductionConfig, type ProductionInstance,
} from "./production-config.ts";
import { AI_DEMO_URL, DEMO_DISTRICT_DEPLOYMENTS, DEMO_DISTRICTS_ONE_ORIGIN } from "./demo-districts.ts";
import { SCHOOLOS_GMAC_IO } from "./schoolos-gmac-io.ts";

const PACKAGES = readDeployablePackages(PACKAGES_DIR);
const BASE_URL = "https://schoolos.gmac.io";

function build(instance: ProductionInstance = SCHOOLOS_GMAC_IO, packages = PACKAGES) {
  return buildProductionConfigs({ instance, packages });
}

/**
 * Production as it was before the one-origin cutover (SCHO-259): the Workshop at schoolos.gmac.io,
 * the district on its own hosts, and the backend bound only for the principal migration. The tests
 * of that layout run against it; the one-origin tests below cover production as it is.
 */
const TWO_HOSTS: ProductionInstance = {
  ...SCHOOLOS_GMAC_IO,
  oneOrigin: { enabled: false, hostname: "northfield.educateos.io" },
  principalBinding: "migration",
};

function configFor(configs: Map<string, ProductionConfig>, pkgName: string): ProductionConfig {
  const config = configs.get(pkgName);
  assert.ok(config, `no production config for ${pkgName}`);
  return config;
}

test("the committed production configs are up to date", () => {
  assert.deepEqual(generateProductionConfigs({ check: true }), [],
      "run `pnpm production:configs` and commit the result");
  for (const [pkgName, config] of build()) {
    const path = join(PACKAGES_DIR, pkgName, PRODUCTION_CONFIG_NAME);
    const text = readFileSync(path, "utf8");
    assert.equal(text, renderProductionConfig(config));
    assert.deepEqual(parse(text), JSON.parse(JSON.stringify(config)), `${path} is not valid JSONC`);
  }
});

test("deploys the router, backend, AI call guard, five gatekeepers and the district", () => {
  assert.deepEqual([...build().keys()], [
    "educateos-ai-guard", DISTRICT_PACKAGE, "gatekeeper-context", "gatekeeper-educateos",
    "gatekeeper-google", "gatekeeper-scheduler", "gatekeeper-websearch", "router", "workshop-backend",
  ]);
  assert.deepEqual(productionPackageNames(SCHOOLOS_GMAC_IO), [...build().keys()]);
});

test("every worker is named for its package unless pinned, on the instance account, with no public URL", () => {
  for (const [pkgName, config] of build()) {
    assert.equal(config.name, SCHOOLOS_GMAC_IO.workerNames?.[pkgName] ?? pkgName);
    assert.equal(config.account_id, SCHOOLOS_GMAC_IO.accountId);
    assert.equal(config.workers_dev, false, pkgName);
    assert.equal(config.preview_urls, false, pkgName);
    assert.equal("previews" in config, false, pkgName);
    if (pkgName !== "router" && pkgName !== DISTRICT_PACKAGE) assert.equal(config.routes, undefined, pkgName);
  }
});

test("the router is the origin, on its custom domain, bound to the backend and the gatekeepers", () => {
  const router = configFor(build(TWO_HOSTS), "router");
  assert.deepEqual(router.routes, [{ pattern: "schoolos.gmac.io", custom_domain: true }]);
  assert.deepEqual(router.services, [
    { binding: "WORKSHOP_BACKEND", service: "workshop-backend" },
    { binding: "GATEKEEPER_CONTEXT", service: "gatekeeper-context" },
    { binding: "GATEKEEPER_EDUCATEOS", service: "gatekeeper-educateos" },
    { binding: "GATEKEEPER_GOOGLE", service: "gatekeeper-google" },
    { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch" },
  ]);
  assert.equal(router.assets?.directory, "../workshop-frontend/dist");
});

test("the backend binds the gatekeepers' vendor entrypoint, the guard, Workers AI and real resources", () => {
  const backend = configFor(build(TWO_HOSTS), "workshop-backend");
  assert.deepEqual(backend.services, [
    { binding: "GATEKEEPER_CONTEXT", service: "gatekeeper-context", entrypoint: "GatekeeperVendor",
      props: { sharingDomain: BASE_URL } },
    { binding: "GATEKEEPER_EDUCATEOS", service: "gatekeeper-educateos", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_GOOGLE", service: "gatekeeper-google", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch", entrypoint: "GatekeeperVendor" },
    { binding: "AI_CALL_GUARD", service: AI_GUARD_PACKAGE, entrypoint: "EducateOsAiCallGuard" },
    { binding: "PRINCIPAL_MIGRATION", service: "schoolos-district-worker", entrypoint: "DistrictPrincipalResolver" },
  ]);
  assert.deepEqual(backend.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(backend.kv_namespaces, [
    { binding: "BLUEPRINTS", id: "23044a01aab84a66b92f7c6bce327af8" },
    { binding: "AVATARS", id: "ca5c9f279799460b82e9c9b35c6e9c9f" },
  ]);
  assert.deepEqual(backend.r2_buckets,
      [{ binding: "BLUEPRINT_CONTENT", bucket_name: "schoolos-prod-blueprint-content" }]);
  assert.deepEqual(backend.vars, {
    PUBLIC_BASE_URL: BASE_URL,
    CF_AI_GATEWAY: "default",
    CF_AI_GATEWAY_ACCOUNT_ID: SCHOOLOS_GMAC_IO.accountId,
    CF_AI_GATEWAY_PROVIDERS: "cloudflare",
  });
});

test("each gatekeeper is mounted under the origin", () => {
  const configs = build(TWO_HOSTS);
  for (const name of SCHOOLOS_GMAC_IO.gatekeepers) {
    const short = name.slice("gatekeeper-".length);
    assert.equal(configFor(configs, name).vars?.BASE_URL, `${BASE_URL}/gatekeeper/${short}`);
  }
  assert.deepEqual(configFor(configs, "gatekeeper-context").kv_namespaces,
      [{ binding: "CONTEXT_COLLECTIONS", id: "0fc6dfd326eb4bb7a7b41f729a6fd9de" }]);
  assert.equal(configFor(configs, "gatekeeper-websearch").vars?.CF_AI_GATEWAY, "default");
});

test("the Google connector gets only its origin; its OAuth client stays a secret", () => {
  const google = configFor(build(TWO_HOSTS), "gatekeeper-google");
  // Its redirect URI, https://schoolos.gmac.io/gatekeeper/google/oauth, derives from BASE_URL.
  assert.deepEqual(google.vars, { BASE_URL: `${BASE_URL}/gatekeeper/google` });
  assert.equal(google.services, undefined);
  assert.equal(google.kv_namespaces, undefined);

  const leaky = structuredClone(SCHOOLOS_GMAC_IO);
  leaky.vars["gatekeeper-google"] = { CLIENT_SECRET: "x" };
  assert.throws(() => build(leaky), /CLIENT_SECRET as a plain-text var/);
});

test("the guard runs its production entrypoint and cron, reaching Hall Monitor by service binding", () => {
  const guard = configFor(build(), AI_GUARD_PACKAGE);
  assert.notEqual(guard.main, AI_GUARD_DEV_MAIN);
  assert.equal(guard.main, ".wrangler/validate/src/worker.ts");
  assert.deepEqual(guard.triggers, { crons: ["17 3 * * *"] });
  // With a district, the guard reads who people are from it (SCHO-283).
  assert.deepEqual(guard.services, [
    { binding: "HALL_MONITOR", service: "hall-monitor" },
    { binding: "EDUCATEOS_DISTRICT", service: "schoolos-district-worker", entrypoint: "DistrictGuardDirectory" },
  ]);
  assert.equal(guard.vars?.HALL_MONITOR_URL, undefined, "the service binding is preferred");
  assert.equal(guard.vars?.HALL_MONITOR_ISSUER, "educateos");
  // A secret: it names the admin's Workshop user, and this repository is public.
  assert.equal(guard.vars?.AI_GUARD_CONFIG, undefined);
});

test("the district Worker has its own custom domains, serves the UIs as assets and keeps its crons", () => {
  const district = configFor(build(TWO_HOSTS), DISTRICT_PACKAGE);
  // Wrangler replaces the Worker's custom domains with this list, so the original stays first and
  // the managed default hostname (SCHO-207) is only added beside it.
  assert.deepEqual(district.routes, [
    { pattern: "district.schoolos.gmac.io", custom_domain: true },
    { pattern: "northfield.educateos.io", custom_domain: true },
  ]);
  assert.deepEqual(district.assets, {
    directory: "./dist/ui",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/healthz", "/lti/*", "/.well-known/educateos.json", "/connect-phone"],
  });
  assert.deepEqual(district.vars, { LTI_TOOL_ORIGIN: "https://district.schoolos.gmac.io" });
  assert.deepEqual(district.triggers, { crons: ["7 * * * *", "0 14 * * SUN"] });
  assert.deepEqual(district.send_email, [{ name: "SEND_EMAIL" }]);
  // The EducateOS connector binds it (SCHO-218), the backend for its principal bindings (SCHO-259)
  // and the guard for its directory (SCHO-283); the backend's EDUCATEOS_DISTRICT_API is left out,
  // since nothing routes to it.
  for (const [pkgName, config] of build(TWO_HOSTS)) {
    const bindings = config.services?.filter(({ service }) =>
      service === DISTRICT_PACKAGE || service === district.name).map(({ binding }) => binding) ?? [];
    assert.deepEqual(bindings, pkgName === EDUCATEOS_GATEKEEPER_PACKAGE || pkgName === AI_GUARD_PACKAGE ? ["EDUCATEOS_DISTRICT"]
        : pkgName === "workshop-backend" ? ["PRINCIPAL_MIGRATION"] : [], pkgName);
  }
});

test("the EducateOS connector reaches the district's school tools by its pinned name, and needs nothing secret", () => {
  const educateos = configFor(build(TWO_HOSTS), EDUCATEOS_GATEKEEPER_PACKAGE);
  assert.deepEqual(educateos.services,
      [{ binding: "EDUCATEOS_DISTRICT", service: "schoolos-district-worker", entrypoint: "DistrictSchoolTools" }]);
  // Its connect page is served at BASE_URL, on the router's hostname behind the instance's Access;
  // the School app's calendar links name the district's own hostname.
  assert.deepEqual(educateos.vars, { BASE_URL: `${BASE_URL}/gatekeeper/educateos`, DISTRICT_URL: "https://district.schoolos.gmac.io" });
  assert.equal(educateos.kv_namespaces, undefined);
  assert.deepEqual(educateos.compatibility_flags, ["allow_irrevocable_stub_storage"]);
});

// The name each Worker that owns Durable Objects is deployed under on schoolos.gmac.io. A Durable
// Object namespace belongs to its Worker's name, so deploying one of these under any other name
// starts it empty beside the real one. The EducateOS rename (SCHO-200) did exactly that to the
// district (SCHO-231). Change an entry only together with a deliberate migration of that Worker's
// state; add one when a new stateful Worker is first deployed.
const DEPLOYED_STATEFUL_WORKERS: Record<string, string> = {
  [DISTRICT_PACKAGE]: "schoolos-district-worker",
  // Redeployed under its new name, with a fresh ledger, on 2026-10-25 (SCHO-231).
  [AI_GUARD_PACKAGE]: "educateos-ai-guard",
  "gatekeeper-context": "gatekeeper-context",
  // First deployed with SCHO-218; its one earlier deploy attempt failed before creating the Worker.
  "gatekeeper-educateos": "gatekeeper-educateos",
  "gatekeeper-google": "gatekeeper-google",
  "gatekeeper-scheduler": "gatekeeper-scheduler",
  "gatekeeper-websearch": "gatekeeper-websearch",
  "workshop-backend": "workshop-backend",
};

test("the district keeps its deployed Worker name through the EducateOS rename", () => {
  assert.equal(DISTRICT_PACKAGE, "educateos-district-worker");
  assert.equal(configFor(build(), DISTRICT_PACKAGE).name, "schoolos-district-worker");
  assert.equal(productionWorkerName(SCHOOLOS_GMAC_IO, DISTRICT_PACKAGE), "schoolos-district-worker");
});

test("every Worker that owns Durable Objects keeps the name it is deployed under", () => {
  const stateful = [...build()].filter(([, config]) => (config.migrations?.length ?? 0) > 0);
  assert.deepEqual(stateful.map(([pkgName]) => pkgName).toSorted(),
      Object.keys(DEPLOYED_STATEFUL_WORKERS).toSorted(),
      "a stateful Worker was added or removed: record its deployed name here deliberately");
  for (const [pkgName, config] of stateful) {
    assert.equal(config.name, DEPLOYED_STATEFUL_WORKERS[pkgName],
        `${pkgName} would deploy as a new Worker, with empty Durable Objects`);
  }
});

test("every service binding reaches a Worker the instance deploys, or Hall Monitor", () => {
  const configs = build();
  const deployed = new Set([...configs.values()].map(({ name }) => name));
  for (const [pkgName, config] of configs) {
    for (const { binding, service } of config.services ?? []) {
      assert.ok(deployed.has(service) || service === SCHOOLOS_GMAC_IO.aiGuard.hallMonitorService,
          `${pkgName}'s ${binding} binds ${service}, which nothing deploys`);
    }
  }
});

test("a pinned name reaches every service binding to that Worker", () => {
  // Pin the guard, which the backend binds; the district's own pin is covered above.
  const pinned = { ...SCHOOLOS_GMAC_IO, workerNames: { [AI_GUARD_PACKAGE]: "schoolos-ai-guard" } };
  const configs = build(pinned);
  assert.equal(configFor(configs, AI_GUARD_PACKAGE).name, "schoolos-ai-guard");
  assert.deepEqual(configFor(configs, "workshop-backend").services?.find(({ binding }) => binding === "AI_CALL_GUARD"),
      { binding: "AI_CALL_GUARD", service: "schoolos-ai-guard", entrypoint: "EducateOsAiCallGuard" });
  for (const [pkgName, config] of configs) {
    assert.equal(config.services?.some(({ service }) => service === AI_GUARD_PACKAGE) ?? false, false, pkgName);
  }
});

test("fails closed on a pin for an undeployed package, a name clash, or a binding to an unknown Worker", () => {
  assert.throws(() => build({ ...SCHOOLOS_GMAC_IO, workerNames: { "gatekeeper-github": "x" } }),
      /pins a Worker name for gatekeeper-github, which it does not deploy/);
  assert.throws(() => build({ ...SCHOOLOS_GMAC_IO, workerNames: { [DISTRICT_PACKAGE]: "router" } }),
      /would be deployed as router/);
  const dangling = PACKAGES.map((pkg) => pkg.name !== AI_GUARD_PACKAGE ? pkg : {
    ...pkg,
    config: { ...pkg.config, services: [{ binding: "GONE", service: "no-such-worker" }] },
  });
  assert.throws(() => build(SCHOOLOS_GMAC_IO, dangling), /GONE binds no-such-worker/);
});

test("an instance without a district deploys no district Worker, and cannot install the EducateOS connector", () => {
  const { district: _district, workerNames: _workerNames, principalBinding: _binding, oneOrigin: _origin, ...withoutDistrict } = SCHOOLOS_GMAC_IO;
  assert.throws(() => build(withoutDistrict), /gatekeeper-educateos needs the instance's district Worker/);
  const withoutConnector = {
    ...withoutDistrict,
    gatekeepers: withoutDistrict.gatekeepers.filter((name) => name !== EDUCATEOS_GATEKEEPER_PACKAGE),
  };
  const configs = build(withoutConnector);
  assert.equal(configs.has(DISTRICT_PACKAGE), false);
  assert.equal(configs.has(EDUCATEOS_GATEKEEPER_PACKAGE), false);
  // Its pinned name has nothing to pin.
  assert.throws(() => build({ ...withoutConnector, workerNames: SCHOOLOS_GMAC_IO.workerNames }),
      /pins a Worker name for educateos-district-worker, which it does not deploy/);
});

test("no generated config carries a secret", () => {
  const secrets = [
    "ADMINS", "AI_GUARD_CONFIG", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "CLIENT_ID", "CLIENT_SECRET", "DISTRICT_CONFIG",
    "HALL_MONITOR_SIGNING_KEY",
  ];
  for (const [pkgName, config] of build()) {
    for (const name of secrets) assert.equal(config.vars?.[name], undefined, `${pkgName} ${name}`);
  }
  const leaky = structuredClone(SCHOOLOS_GMAC_IO);
  leaky.vars["workshop-backend"] = { ...leaky.vars["workshop-backend"], ADMINS: "[]" };
  assert.throws(() => build(leaky), /ADMINS as a plain-text var/);
});

test("fails closed on a resource binding the instance does not name, or one it names in vain", () => {
  const extra = PACKAGES.map((pkg) => pkg.name !== "workshop-backend" ? pkg : {
    ...pkg,
    config: { ...pkg.config, kv_namespaces: [...pkg.config.kv_namespaces ?? [], { binding: "NEW_KV" }] },
  });
  assert.throws(() => build(SCHOOLOS_GMAC_IO, extra), /declares KV namespace NEW_KV/);

  const stale = structuredClone(SCHOOLOS_GMAC_IO);
  stale.r2Buckets["workshop-backend"] = { ...stale.r2Buckets["workshop-backend"], GONE: "bucket" };
  assert.throws(() => build(stale), /names R2 bucket GONE/);
});


// The demo districts (SCHO-210): five separate district Workers, each at `<slug>.educateos.io`.

const DEMOS = buildDemoDistrictConfigs({ districts: DEMO_DISTRICT_DEPLOYMENTS, packages: PACKAGES, instance: SCHOOLOS_GMAC_IO });

// Each demo district's deployed Worker name. As for DEPLOYED_STATEFUL_WORKERS: each owns its
// district's Durable Object, so a changed name would start that district empty. Change an entry
// only together with a deliberate migration; add one when a demo district is first deployed.
const DEPLOYED_DEMO_DISTRICT_WORKERS: Record<string, string> = {
  riverbend: "educateos-riverbend-district",
  prairie: "educateos-prairie-district",
  cedarvalley: "educateos-cedarvalley-district",
  lakeshore: "educateos-lakeshore-district",
  harbor: "educateos-harbor-district",
};

test("deploys five demo districts beside northfield, each its own Worker at its own hostname", () => {
  assert.deepEqual([...DEMOS.keys()], ["riverbend", "prairie", "cedarvalley", "lakeshore", "harbor"]);
  const district = configFor(build(), DISTRICT_PACKAGE);
  for (const [slug, config] of DEMOS) {
    assert.equal(config.name, DEPLOYED_DEMO_DISTRICT_WORKERS[slug],
        `${slug} would deploy as a new Worker, with an empty Durable Object`);
    assert.equal(config.account_id, SCHOOLOS_GMAC_IO.accountId);
    assert.equal(config.workers_dev, false, slug);
    assert.equal(config.preview_urls, false, slug);
    // Only its own hostname: Wrangler detaches any custom domain a deploy does not list, so a demo
    // must never list northfield's (or another demo's).
    assert.deepEqual(config.routes, [{ pattern: `${slug}.educateos.io`, custom_domain: true }]);
    // On one origin (DEMO_DISTRICTS_ONE_ORIGIN): its manifest, without AI, and Northfield's /ai to link to.
    assert.deepEqual(config.vars, {
      LTI_TOOL_ORIGIN: `https://${slug}.educateos.io`,
      AI_DEMO_URL: AI_DEMO_URL,
      SCHOOL_MANIFEST: JSON.stringify({ origin: `https://${slug}.educateos.io`, features: { ai: false } }),
    });
    // The district's assets, with /ai run through the Worker for its "AI isn't enabled" page.
    assert.deepEqual(config.assets, { ...district.assets, run_worker_first: [
      ...(district.assets?.run_worker_first as string[] | undefined ?? []).filter((path) => path !== "/ai" && path !== "/ai/*"),
      "/ai", "/ai/*",
    ] });
    assert.deepEqual(config.triggers, district.triggers);
    assert.deepEqual(config.migrations, district.migrations);
    assert.equal(config.services, undefined, slug);
    assert.equal(demoDistrictConfigName(slug), `wrangler.demo-${slug}.jsonc`);
    const path = join(PACKAGES_DIR, DISTRICT_PACKAGE, demoDistrictConfigName(slug));
    assert.equal(readFileSync(path, "utf8"), renderProductionConfig(config), `${path} is out of date`);
  }
});

test("demo districts never take northfield's hostname, a Worker name already deployed, or each other's", () => {
  const northfield = { slug: "northfield", accountId: SCHOOLOS_GMAC_IO.accountId, hostname: "northfield.educateos.io" };
  assert.throws(() => buildDemoDistrictConfigs({ districts: [northfield], packages: PACKAGES, instance: SCHOOLOS_GMAC_IO }),
      /northfield.educateos.io is already another district's hostname/);
  const twice = [DEMO_DISTRICT_DEPLOYMENTS[0]!, DEMO_DISTRICT_DEPLOYMENTS[0]!];
  assert.throws(() => buildDemoDistrictConfigs({ districts: twice, packages: PACKAGES }), /two Workers would be deployed/);
  const clash = { ...DEMO_DISTRICT_DEPLOYMENTS[1]!, hostname: DEMO_DISTRICT_DEPLOYMENTS[0]!.hostname };
  assert.throws(() => buildDemoDistrictConfigs({ districts: [DEMO_DISTRICT_DEPLOYMENTS[0]!, clash], packages: PACKAGES }),
      /already another district's hostname/);
  assert.throws(() => buildDemoDistrictConfigs({ districts: [{ ...northfield, slug: "Bad_Slug" }], packages: PACKAGES }),
      /not a district slug/);
  assert.equal(demoDistrictWorkerName("prairie"), "educateos-prairie-district");
});

test("no demo district config carries a secret", () => {
  for (const [slug, config] of DEMOS) {
    for (const name of ["CF_ACCESS_AUD", "CF_ACCESS_ISS", "DISTRICT_CONFIG"]) assert.equal(config.vars?.[name], undefined, `${slug} ${name}`);
  }
});


// One origin per district (ADR-0014, SCHO-259): on for the instance since the cutover, still off
// for the demo districts.

/** The configs as they would be with no one-origin flag at all, before the flags existed. */
function withoutFlags() {
  const { oneOrigin: _oneOrigin, ...instance } = TWO_HOSTS;
  const districts = DEMO_DISTRICT_DEPLOYMENTS.map(({ oneOrigin: _flag, ...district }) => district);
  return { instance, districts };
}

const ONE_ORIGIN: ProductionInstance = { ...TWO_HOSTS, oneOrigin: { enabled: true, hostname: "northfield.educateos.io" } };
const NORTHFIELD = "https://northfield.educateos.io";

test("production is on one origin, built for /ai, and the flags off change no generated byte", () => {
  assert.deepEqual(SCHOOLOS_GMAC_IO.oneOrigin, { enabled: true, hostname: "northfield.educateos.io" });
  assert.equal(SCHOOLOS_GMAC_IO.principalBinding, "resolver");
  assert.deepEqual(productionBuildEnv(SCHOOLOS_GMAC_IO), { router: { VITE_WORKSHOP_BASE_PATH: "/ai/" } });
  // Build env is not in a Wrangler config: the router target's buildCommand must carry it.
  const forgegraph = readFileSync(join(PACKAGES_DIR, "..", ".forgegraph.yaml"), "utf8");
  const routerBuild = forgegraph.split("- name: router")[1]?.match(/buildCommand: (.*)/)?.[1] ?? "";
  assert.match(routerBuild, / VITE_WORKSHOP_BASE_PATH=\/ai\/ /);
  assert.equal(DEMO_DISTRICTS_ONE_ORIGIN, true);
  for (const district of DEMO_DISTRICT_DEPLOYMENTS) assert.equal(district.oneOrigin?.enabled, true, district.slug);
  assert.deepEqual(productionBuildEnv(TWO_HOSTS), {});

  const { instance, districts } = withoutFlags();
  const render = (configs: Map<string, ProductionConfig>) => [...configs].map(([name, config]) => [name, renderProductionConfig(config)]);
  assert.deepEqual(render(build(TWO_HOSTS)), render(build(instance)));
  const demosOff = DEMO_DISTRICT_DEPLOYMENTS.map((district) =>
    ({ ...district, ...district.oneOrigin ? { oneOrigin: { ...district.oneOrigin, enabled: false } } : {} }));
  assert.deepEqual(render(buildDemoDistrictConfigs({ districts: demosOff, packages: PACKAGES, instance: SCHOOLOS_GMAC_IO })),
      render(buildDemoDistrictConfigs({ districts, packages: PACKAGES, instance })));
  // And what they render is what is committed (also the first test's check, restated for the flags).
  assert.deepEqual(generateProductionConfigs({ check: true }), []);
});

test("one origin: the router serves northfield.educateos.io, fronts the district, and keeps the old hostnames to redirect", () => {
  const router = configFor(build(ONE_ORIGIN), "router");
  assert.deepEqual(router.routes, [
    { pattern: "northfield.educateos.io", custom_domain: true },
    { pattern: "schoolos.gmac.io", custom_domain: true },
    { pattern: "district.schoolos.gmac.io", custom_domain: true },
  ]);
  assert.deepEqual(router.services?.find(({ binding }) => binding === "DISTRICT"),
      { binding: "DISTRICT", service: "schoolos-district-worker" });
  assert.equal(router.assets?.run_worker_first, true);
  assert.equal(router.assets?.directory, "../workshop-frontend/dist");
  assert.deepEqual(JSON.parse(String(router.vars?.LEGACY_HOSTS)), {
    "schoolos.gmac.io": `${NORTHFIELD}/ai`,
    "district.schoolos.gmac.io": NORTHFIELD,
  });
  // Northfield is the AI-enabled demo district: AI_ENABLED stays unset.
  assert.equal(router.vars?.AI_ENABLED, undefined);
  assert.deepEqual(productionBuildEnv(ONE_ORIGIN), { router: { VITE_WORKSHOP_BASE_PATH: "/ai/" } });
});

test("one origin: the Workshop and gatekeepers move to the district's hostname, the Workshop under /ai", () => {
  const configs = build(ONE_ORIGIN);
  const backend = configFor(configs, "workshop-backend");
  assert.equal(backend.vars?.PUBLIC_BASE_URL, NORTHFIELD);
  assert.equal(backend.vars?.PUBLIC_BASE_PATH, "/ai");
  assert.equal(configFor(configs, "gatekeeper-google").vars?.BASE_URL, `${NORTHFIELD}/gatekeeper/google`);
  assert.deepEqual(configFor(configs, EDUCATEOS_GATEKEEPER_PACKAGE).vars,
      { BASE_URL: `${NORTHFIELD}/gatekeeper/educateos`, DISTRICT_URL: NORTHFIELD });
  // gatekeeper-context's sharing domain is the origin too.
  assert.deepEqual(backend.services?.find(({ binding }) => binding === "GATEKEEPER_CONTEXT")?.props, { sharingDomain: NORTHFIELD });
});

test("one origin: the district Worker gives up its hostnames, keeps its name, LTI origin and assets, and publishes its manifest", () => {
  const district = configFor(build(ONE_ORIGIN), DISTRICT_PACKAGE);
  assert.equal(district.name, "schoolos-district-worker");
  assert.equal(district.routes, undefined);
  assert.equal(district.workers_dev, false);
  assert.deepEqual(district.assets, configFor(build(), DISTRICT_PACKAGE).assets);
  assert.deepEqual(district.vars, {
    LTI_TOOL_ORIGIN: "https://district.schoolos.gmac.io",
    SCHOOL_MANIFEST: JSON.stringify({ origin: NORTHFIELD, features: { ai: true } }),
  });
  // Still reached only through its bindings: the router's DISTRICT, the connector's school tools,
  // the backend's principal bindings and the guard's directory (SCHO-283).
  for (const [pkgName, config] of build(ONE_ORIGIN)) {
    const binds = config.services?.some(({ service }) => service === "schoolos-district-worker") ?? false;
    assert.equal(binds, ["router", EDUCATEOS_GATEKEEPER_PACKAGE, "workshop-backend", AI_GUARD_PACKAGE].includes(pkgName), pkgName);
  }
});

test("one origin: every stateful Worker keeps its name, and nothing carries a secret", () => {
  for (const [pkgName, config] of build(ONE_ORIGIN)) {
    if ((config.migrations?.length ?? 0) > 0) assert.equal(config.name, DEPLOYED_STATEFUL_WORKERS[pkgName], pkgName);
    for (const name of ["CF_ACCESS_AUD", "CF_ACCESS_ISS", "DISTRICT_CONFIG", "DEVICE_TOKEN_SECRET"]) {
      assert.equal(config.vars?.[name], undefined, `${pkgName} ${name}`);
    }
  }
  const leaky = structuredClone(ONE_ORIGIN);
  leaky.vars[DISTRICT_PACKAGE] = { DEVICE_TOKEN_SECRET: "x" };
  assert.throws(() => build(leaky), /DEVICE_TOKEN_SECRET as a plain-text var/);
});

test("one origin fails closed without a district, or on the instance's own hostname", () => {
  const { district: _district, workerNames: _names, ...withoutDistrict } = ONE_ORIGIN;
  assert.throws(() => build({ ...withoutDistrict, gatekeepers: withoutDistrict.gatekeepers.filter((name) => name !== EDUCATEOS_GATEKEEPER_PACKAGE) }),
      /needs a district Worker/);
  assert.throws(() => build({ ...ONE_ORIGIN, oneOrigin: { enabled: true, hostname: "schoolos.gmac.io" } }), /instance's old hostname/);
});

test("one origin: a demo district answers /ai itself, linking to Northfield, and changes nothing else", () => {
  const on: DemoDistrictDeployment[] = DEMO_DISTRICT_DEPLOYMENTS.map((district) => ({ ...district, oneOrigin: { enabled: true, aiDemoUrl: AI_DEMO_URL } }));
  const configs = buildDemoDistrictConfigs({ districts: on, packages: PACKAGES, instance: ONE_ORIGIN });
  assert.equal(AI_DEMO_URL, "https://northfield.educateos.io/ai/");
  for (const [slug, config] of configs) {
    const before = DEMOS.get(slug)!;
    assert.equal(config.name, before.name);
    assert.deepEqual(config.routes, before.routes);
    assert.deepEqual(config.assets?.run_worker_first,
        ["/api/*", "/healthz", "/lti/*", "/.well-known/educateos.json", "/connect-phone", "/ai", "/ai/*"]);
    assert.deepEqual(config.vars, {
      LTI_TOOL_ORIGIN: `https://${slug}.educateos.io`,
      AI_DEMO_URL,
      SCHOOL_MANIFEST: JSON.stringify({ origin: `https://${slug}.educateos.io`, features: { ai: false } }),
    });
    const { assets: _a, vars: _v, ...rest } = config;
    const { assets: _b, vars: _w, ...restBefore } = before;
    assert.deepEqual(rest, restBefore, slug);
  }
});

test("the principal bindings reach the district's resolver by its pinned name, one cutover step at a time", () => {
  const services = (principalBinding?: "migration" | "resolver") =>
    configFor(build({ ...SCHOOLOS_GMAC_IO, ...principalBinding ? { principalBinding } : {} }), "workshop-backend").services
        ?.filter(({ binding }) => binding.startsWith("PRINCIPAL_"));
  // Production is past the cutover: both bindings.
  assert.equal(SCHOOLOS_GMAC_IO.principalBinding, "resolver");
  assert.deepEqual(services(), [
    { binding: "PRINCIPAL_MIGRATION", service: "schoolos-district-worker", entrypoint: "DistrictPrincipalResolver" },
    { binding: "PRINCIPAL_RESOLVER", service: "schoolos-district-worker", entrypoint: "DistrictPrincipalResolver" },
  ]);
  const { principalBinding: _binding, ...unbound } = SCHOOLOS_GMAC_IO;
  assert.deepEqual(configFor(build(unbound), "workshop-backend").services
      ?.filter(({ binding }) => binding.startsWith("PRINCIPAL_")), []);
  const migration = { binding: "PRINCIPAL_MIGRATION", service: "schoolos-district-worker", entrypoint: "DistrictPrincipalResolver" };
  assert.deepEqual(services("migration"), [migration]);
  assert.deepEqual(services("resolver"), [migration, { ...migration, binding: "PRINCIPAL_RESOLVER" }]);
  const { district: _district, workerNames: _names, ...withoutDistrict } = TWO_HOSTS;
  assert.throws(() => build({
    ...withoutDistrict, principalBinding: "migration",
    gatekeepers: withoutDistrict.gatekeepers.filter((name) => name !== EDUCATEOS_GATEKEEPER_PACKAGE),
  }), /principal bindings need the instance's district Worker/);
});
