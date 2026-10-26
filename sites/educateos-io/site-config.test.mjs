// The site Worker's config holds the control plane's state (SCHO-206), so parts of it may never
// change. Run: node --test sites/educateos-io/site-config.test.mjs

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {test} from "node:test";
import {DYNAMIC_PATHS} from "../../packages/educateos-control-plane/src/app.ts";

// jsonc-parser is a dependency of the shared scripts package, as the production configs read it there.
const {parse} = createRequire(new URL("../../scripts/package.json", import.meta.url))("jsonc-parser");
const config = parse(readFileSync(new URL("wrangler.jsonc", import.meta.url), "utf8"));

test("the Worker and its Durable Object class keep the names their data lives under", () => {
  // A renamed Worker or class gets a new, empty Durable Object namespace: every operator and
  // installation record would be gone (SCHO-231).
  assert.equal(config.name, "educateos-site");
  assert.deepEqual(config.durable_objects.bindings, [{name: "CONTROL_PLANE", class_name: "ControlPlane"}]);
  assert.deepEqual(config.migrations[0], {tag: "v1", new_sqlite_classes: ["ControlPlane"]});
  assert.ok(!config.migrations.some((m) => m.deleted_classes || m.renamed_classes), "a migration may not delete or rename a class");
});

test("the paths that reach the Worker first are the ones the control plane routes", () => {
  assert.deepEqual(config.assets.run_worker_first, [...DYNAMIC_PATHS]);
});

test("the console verifies Access assertions for its own application", () => {
  assert.equal(config.vars.ACCESS_ISSUER, "https://gmacko.cloudflareaccess.com");
  assert.match(config.vars.ACCESS_AUD, /^[0-9a-f]{64}$/);
  assert.equal(config.workers_dev, false, "a workers.dev address would serve /app without Access in front");
  assert.equal(config.preview_urls, false, "so would a preview URL");
});
