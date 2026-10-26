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
  DISTRICT_PACKAGE, PRODUCTION_CONFIG_NAME, EDUCATEOS_GATEKEEPER_PACKAGE, buildProductionConfigs,
  generateProductionConfigs, productionPackageNames, productionWorkerName, renderProductionConfig,
  type ProductionConfig, type ProductionInstance,
} from "./production-config.ts";
import { SCHOOLOS_GMAC_IO } from "./schoolos-gmac-io.ts";

const PACKAGES = readDeployablePackages(PACKAGES_DIR);
const BASE_URL = "https://schoolos.gmac.io";

function build(instance: ProductionInstance = SCHOOLOS_GMAC_IO, packages = PACKAGES) {
  return buildProductionConfigs({ instance, packages });
}

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
  const router = configFor(build(), "router");
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
  const backend = configFor(build(), "workshop-backend");
  assert.deepEqual(backend.services, [
    { binding: "GATEKEEPER_CONTEXT", service: "gatekeeper-context", entrypoint: "GatekeeperVendor",
      props: { sharingDomain: BASE_URL } },
    { binding: "GATEKEEPER_EDUCATEOS", service: "gatekeeper-educateos", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_GOOGLE", service: "gatekeeper-google", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch", entrypoint: "GatekeeperVendor" },
    { binding: "AI_CALL_GUARD", service: AI_GUARD_PACKAGE, entrypoint: "EducateOsAiCallGuard" },
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
  const configs = build();
  for (const name of SCHOOLOS_GMAC_IO.gatekeepers) {
    const short = name.slice("gatekeeper-".length);
    assert.equal(configFor(configs, name).vars?.BASE_URL, `${BASE_URL}/gatekeeper/${short}`);
  }
  assert.deepEqual(configFor(configs, "gatekeeper-context").kv_namespaces,
      [{ binding: "CONTEXT_COLLECTIONS", id: "0fc6dfd326eb4bb7a7b41f729a6fd9de" }]);
  assert.equal(configFor(configs, "gatekeeper-websearch").vars?.CF_AI_GATEWAY, "default");
});

test("the Google connector gets only its origin; its OAuth client stays a secret", () => {
  const google = configFor(build(), "gatekeeper-google");
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
  assert.deepEqual(guard.services, [{ binding: "HALL_MONITOR", service: "hall-monitor" }]);
  assert.equal(guard.vars?.HALL_MONITOR_URL, undefined, "the service binding is preferred");
  assert.equal(guard.vars?.HALL_MONITOR_ISSUER, "educateos");
  // A secret: it names the admin's Workshop user, and this repository is public.
  assert.equal(guard.vars?.AI_GUARD_CONFIG, undefined);
});

test("the district Worker has its own custom domains, serves the UIs as assets and keeps its crons", () => {
  const district = configFor(build(), DISTRICT_PACKAGE);
  // Wrangler replaces the Worker's custom domains with this list, so the original stays first and
  // the managed default hostname (SCHO-207) is only added beside it.
  assert.deepEqual(district.routes, [
    { pattern: "district.schoolos.gmac.io", custom_domain: true },
    { pattern: "northfield.educateos.io", custom_domain: true },
  ]);
  assert.deepEqual(district.assets, {
    directory: "./dist/ui",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/healthz"],
  });
  assert.deepEqual(district.triggers, { crons: ["7 * * * *", "0 14 * * SUN"] });
  assert.deepEqual(district.send_email, [{ name: "SEND_EMAIL" }]);
  // Only the EducateOS connector binds it (SCHO-218); the guard keeps its configured directory
  // (SCHO-147), and the backend's EDUCATEOS_DISTRICT_API is left out, since nothing routes to it.
  for (const [pkgName, config] of build()) {
    const binds = config.services?.some(({ service }) =>
      service === DISTRICT_PACKAGE || service === district.name) ?? false;
    assert.equal(binds, pkgName === EDUCATEOS_GATEKEEPER_PACKAGE, pkgName);
  }
});

test("the EducateOS connector reaches the district's school tools by its pinned name, and needs nothing secret", () => {
  const educateos = configFor(build(), EDUCATEOS_GATEKEEPER_PACKAGE);
  assert.deepEqual(educateos.services,
      [{ binding: "EDUCATEOS_DISTRICT", service: "schoolos-district-worker", entrypoint: "DistrictSchoolTools" }]);
  // Its connect page is served at BASE_URL, on the router's hostname behind the instance's Access.
  assert.deepEqual(educateos.vars, { BASE_URL: `${BASE_URL}/gatekeeper/educateos` });
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
  const { district: _district, workerNames: _workerNames, ...withoutDistrict } = SCHOOLOS_GMAC_IO;
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

