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
  DISTRICT_PACKAGE, PRODUCTION_CONFIG_NAME, buildProductionConfigs, generateProductionConfigs,
  productionPackageNames, renderProductionConfig, type ProductionConfig, type ProductionInstance,
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

test("deploys the router, backend, AI call guard, three auto-provisioned gatekeepers and the district", () => {
  assert.deepEqual([...build().keys()], [
    "gatekeeper-context", "gatekeeper-scheduler", "gatekeeper-websearch", "router",
    "schoolos-ai-guard", DISTRICT_PACKAGE, "workshop-backend",
  ]);
  assert.deepEqual(productionPackageNames(SCHOOLOS_GMAC_IO), [...build().keys()]);
});

test("every worker is named for its package, on the instance account, with no public URL", () => {
  for (const [pkgName, config] of build()) {
    assert.equal(config.name, pkgName);
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
    { binding: "GATEKEEPER_SCHEDULER", service: "gatekeeper-scheduler", entrypoint: "GatekeeperVendor" },
    { binding: "GATEKEEPER_WEBSEARCH", service: "gatekeeper-websearch", entrypoint: "GatekeeperVendor" },
    { binding: "AI_CALL_GUARD", service: AI_GUARD_PACKAGE, entrypoint: "SchoolOsAiCallGuard" },
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

test("the guard runs its production entrypoint and cron, reaching Hall Monitor by service binding", () => {
  const guard = configFor(build(), AI_GUARD_PACKAGE);
  assert.notEqual(guard.main, AI_GUARD_DEV_MAIN);
  assert.equal(guard.main, ".wrangler/validate/src/worker.ts");
  assert.deepEqual(guard.triggers, { crons: ["17 3 * * *"] });
  assert.deepEqual(guard.services, [{ binding: "HALL_MONITOR", service: "hall-monitor" }]);
  assert.equal(guard.vars?.HALL_MONITOR_URL, undefined, "the service binding is preferred");
  assert.equal(guard.vars?.HALL_MONITOR_ISSUER, "schoolos");
  // A secret: it names the admin's Workshop user, and this repository is public.
  assert.equal(guard.vars?.AI_GUARD_CONFIG, undefined);
});

test("the district Worker has its own custom domain, serves the UIs as assets and keeps its crons", () => {
  const district = configFor(build(), DISTRICT_PACKAGE);
  assert.deepEqual(district.routes, [{ pattern: "district.schoolos.gmac.io", custom_domain: true }]);
  assert.deepEqual(district.assets, {
    directory: "./dist/ui",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/healthz"],
  });
  assert.deepEqual(district.triggers, { crons: ["7 * * * *", "0 14 * * SUN"] });
  assert.deepEqual(district.send_email, [{ name: "SEND_EMAIL" }]);
  // Nothing binds it yet: the guard keeps its configured directory (SCHO-147).
  for (const [pkgName, config] of build()) {
    assert.equal(config.services?.some(({ service }) => service === DISTRICT_PACKAGE) ?? false, false, pkgName);
  }
});

test("an instance without a district deploys no district Worker", () => {
  const { district: _district, ...withoutDistrict } = SCHOOLOS_GMAC_IO;
  assert.equal(build(withoutDistrict).has(DISTRICT_PACKAGE), false);
});

test("no generated config carries a secret", () => {
  const secrets = [
    "ADMINS", "AI_GUARD_CONFIG", "CF_ACCESS_AUD", "CF_ACCESS_ISS", "DISTRICT_CONFIG", "HALL_MONITOR_SIGNING_KEY",
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

