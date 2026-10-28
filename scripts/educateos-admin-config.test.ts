// The hosted admin's production config (packages/educateos-admin/wrangler.production.jsonc,
// SCHO-263) is deployed only by its own ForgeGraph app, `educateos-admin`. Nothing in this
// repository may pick it up on its own: release discovery, the worker config generator, the
// staging, preview and production generators and the dev server all key on a package's
// `wrangler.jsonc`, which the admin must therefore never have, and the primary ForgeGraph app's
// .forgegraph.yaml must not name it. A merge to main deploys every target of that app.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { workerConfigDirs } from "./generate-worker-configs.ts";
import { ADMIN_PACKAGE, readDeployablePackages, readReleaseComponents } from "./release/manifest-lib.ts";

const ADMIN_DIR = join("packages", "educateos-admin");
/** The parts of the config these tests read. */
interface AdminProductionConfig {
  name: string;
  routes: unknown;
  workers_dev: boolean;
  preview_urls: boolean;
  assets: { run_worker_first: string[] };
  observability: { enabled: boolean };
  d1_databases: { binding: string; database_name: string; database_id: string; migrations_dir: string }[];
  services: unknown;
  vars: Record<string, string | undefined>;
}

const config = parse(readFileSync(join(ADMIN_DIR, "wrangler.production.jsonc"), "utf8")) as AdminProductionConfig;

test("the admin has no wrangler.jsonc, the name every generator and release discovery key on", () => {
  assert.equal(existsSync(join(ADMIN_DIR, "wrangler.jsonc")), false);
  assert.equal(existsSync(join(ADMIN_DIR, "cloudflare.config.ts")), false);
});

test("release discovery and the config generators don't see the admin", () => {
  assert.ok(!readDeployablePackages("packages").some((pkg) => pkg.name === "educateos-admin"),
    "release discovery (and the staging, preview and production generators built on it) found the admin");
  assert.ok(!workerConfigDirs().some((dir) => dir.endsWith(join("packages", "educateos-admin"))),
    "the worker config generator found the admin");
});

// SCHO-263: the district release carries the OSS admin, built from its own config template through
// manifest-lib's RELEASE_COMPONENTS rather than discovery. The template names nothing account-specific.
test("the release finds the admin only as a component, from a template with nothing account-specific", () => {
  const components = readReleaseComponents("packages");
  assert.deepEqual(components.map((pkg) => [pkg.name, pkg.component?.configFile]), [[ADMIN_PACKAGE, "wrangler.release.jsonc"]]);
  const template = components[0]!.config as unknown as AdminProductionConfig;
  assert.equal(template.name, "educateos-admin");
  assert.deepEqual(template.vars, { EDITION: "oss" });
  assert.equal(template.routes, undefined, "the installer attaches the district's hostname");
  assert.equal(template.services, undefined, "the OSS admin has no control-plane binding");
  assert.deepEqual(template.assets.run_worker_first, ["/api/*", "/healthz"]);
  assert.deepEqual(template.d1_databases.map((db) => [db.binding, db.migrations_dir]), [["DB", "migrations"]]);
});

test("the primary app's ForgeGraph config doesn't deploy it", () => {
  const forgegraph = readFileSync(".forgegraph.yaml", "utf8");
  assert.doesNotMatch(forgegraph, /educateos-admin/);
});

test("the production config is the hosted edition at admin.educateos.io, on its custom domain only", () => {
  assert.equal(config.name, "educateos-admin");
  assert.equal(config.vars.EDITION, "hosted");
  assert.deepEqual(config.routes, [{ pattern: "admin.educateos.io", custom_domain: true }]);
  assert.equal(config.workers_dev, false, "a workers.dev address would serve the admin without Access in front");
  assert.equal(config.preview_urls, false, "so would a preview URL");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*", "/healthz"]);
  assert.equal(config.observability.enabled, true);
});

test("its D1 database and Access audience are placeholders until provisioned, and no secret is in it", () => {
  // Either still the placeholder, or what provisioning put in its place (the runbook's steps 1 and 2).
  const [database] = config.d1_databases;
  assert.equal(config.d1_databases.length, 1);
  assert.deepEqual({ ...database, database_id: "" }, { binding: "DB", database_name: "educateos-admin", database_id: "", migrations_dir: "migrations" });
  assert.match(database!.database_id, /^(REPLACE_AT_PROVISION|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  assert.match(config.vars.ACCESS_AUD ?? "", /^(REPLACE_AT_PROVISION_ACCESS_AUD|[0-9a-f]{64})$/);
  assert.equal(config.vars.ACCESS_ISSUER, "https://gmacko.cloudflareaccess.com");
  for (const secret of ["ADMIN_KEY_ENCRYPTION_KEY", "ADMINS"]) assert.equal(config.vars[secret], undefined, `${secret} is a secret`);
});

test("it reads educateos.io's control plane only through the export entrypoint", () => {
  assert.deepEqual(config.services, [{ binding: "CONTROL_PLANE", service: "educateos-site", entrypoint: "ControlPlaneExporter" }]);
});
