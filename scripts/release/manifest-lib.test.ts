// Golden test for the release manifest generator, run against the repo's REAL wrangler.jsonc
// configs (with fixture bundles/assets substituted for actual builds, so no compilation is
// needed). A deliberate consequence: changing any deployable package's wrangler.jsonc fails this
// test until testdata/golden-manifest.json is regenerated — forcing a conscious decision
// about how the change reaches customer instances.
//
// Regenerate with: UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssets, collectModules, stableStringify } from "./hash-lib.ts";
import {
  generateManifest, readD1Migrations, readDeployablePackages, readDeployInputs, releaseShortName,
  type WorkerBuild,
} from "./manifest-lib.ts";

const RELEASE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(RELEASE, "..", "..");
const TESTDATA = join(RELEASE, "testdata");
const GOLDEN_PATH = join(TESTDATA, "golden-manifest.json");

// Placeholder syntax the deploy-side renderer understands. Closed list — see manifest-lib.ts.
const PLACEHOLDER_RE =
    /^\$(ACCOUNT_ID|PUBLIC_BASE_URL|KV_[A-Z0-9_]+_ID|R2_[A-Z0-9_]+_NAME|D1_[A-Z0-9_]+_ID|WORKER_NAME\([a-z0-9-]+\)|SECRET\([A-Z0-9_]+\))/;

function readTestWorkerBuilds() {
  return readDeployablePackages(join(ROOT, "packages")).map((pkg) => {
    const bundleDir = join(TESTDATA, "fixture-bundles", pkg.name);
    assert.ok(existsSync(bundleDir),
        `missing fixture bundle for new deployable package: add scripts/release/testdata/` +
        `fixture-bundles/${pkg.name}/ with a single .js module`);
    const { mainModule, modules } = collectModules(bundleDir);
    return {
      pkgName: pkg.name,
      config: pkg.config,
      mainModule,
      modules,
      deployInputs: readDeployInputs(pkg.dir),
    };
  });
}

function buildTestManifest(workers: WorkerBuild[] = readTestWorkerBuilds()) {
  return generateManifest({
    releaseId: "r000000-fixture",
    commit: "0000000000000000000000000000000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    wranglerVersion: "0.0.0-fixture",
    workers,
    assetVariants: {
      access: collectAssets(join(TESTDATA, "fixture-assets", "access")),
    },
  });
}

test("manifest generated from real configs matches the golden file", () => {
  const manifest = buildTestManifest();
  const rendered = stableStringify(manifest) + "\n";
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, rendered);
    return;
  }
  assert.ok(existsSync(GOLDEN_PATH), "golden manifest missing; run with UPDATE_GOLDEN=1");
  assert.deepEqual(JSON.parse(rendered), JSON.parse(readFileSync(GOLDEN_PATH, "utf8")),
      "manifest changed. If the wrangler.jsonc change is intentional, verify the deploy " +
      "service handles it, then regenerate: UPDATE_GOLDEN=1 node --test " +
      "scripts/release/manifest-lib.test.ts");
});

test("every $-token in binding templates and vars uses known placeholder syntax", () => {
  const manifest = buildTestManifest();
  const check = (value: unknown, where: string): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\$[A-Z_]+[A-Za-z0-9_()-]*/g)) {
        assert.match(match[0], PLACEHOLDER_RE, `unknown placeholder ${match[0]} in ${where}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => check(v, `${where}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) check(v, `${where}.${k}`);
    }
  };
  for (const [name, entry] of Object.entries(manifest.workers)) {
    check(entry.bindings, `${name}.bindings`);
    check(entry.vars, `${name}.vars`);
    check(entry.gatekeeperBindingExpansion ?? {}, `${name}.gatekeeperBindingExpansion`);
  }
});

test("worker entries carry the deploy contract", () => {
  const manifest = buildTestManifest();
  const { workers } = manifest;

  // Core workers exist with the right kinds.
  assert.equal(workers["workshop-backend"].kind, "backend");
  assert.equal(workers["router"].kind, "router");

  // Backend: provisioned resources are placeholders; gatekeeper calls use GatekeeperVendor.
  const backend = workers["workshop-backend"];
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "BLUEPRINTS"),
      { type: "kv_namespace", name: "BLUEPRINTS", namespace_id: "$KV_BLUEPRINTS_ID" });
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "BLUEPRINT_CONTENT"),
      { type: "r2_bucket", name: "BLUEPRINT_CONTENT", bucket_name: "$R2_BLUEPRINT_CONTENT_NAME" });
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "LOADER"),
      { type: "worker_loader", name: "LOADER" });
  // The Workers AI binding always ships (webFetch's toMarkdown conversion depends on it).
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "WORKERS_AI"),
      { type: "ai", name: "WORKERS_AI" });
  assert.ok(backend.gatekeeperBindingExpansion);
  assert.equal(backend.gatekeeperBindingExpansion.entrypoint, "GatekeeperVendor");
  assert.equal(backend.vars.PUBLIC_BASE_URL, "$PUBLIC_BASE_URL");
  // Full ordered migration history, verbatim from wrangler.jsonc.
  assert.equal(backend.migrations[0].tag, "v0");
  assert.ok(backend.migrations[0].new_sqlite_classes?.includes("UserDurableObject"));

  // Router: serves the access asset variant, binds the backend by templated worker name.
  const router = workers["router"];
  assert.deepEqual(
      router.bindings.find((b) => b.name === "WORKSHOP_BACKEND"),
      { type: "service", name: "WORKSHOP_BACKEND", service: "$WORKER_NAME(workshop-backend)" });
  assert.ok(router.bindings.some((b) => b.type === "assets" && b.name === "ASSETS"));
  assert.ok(router.assetsConfig);
  assert.ok(router.assetsConfig.run_worker_first?.includes("/gatekeeper/*"));
  assert.equal(router.assetsConfig.not_found_handling, "single-page-application");
  assert.deepEqual(Object.keys(router.assetsConfig.variants), ["access"]);
  for (const variant of Object.values(router.assetsConfig.variants)) {
    for (const { hash } of Object.values(variant.manifest)) {
      assert.ok(manifest.assets[hash], `asset blob ${hash} missing from release index`);
      assert.equal(manifest.assets[hash].r2Key, `blobs/assets/${hash}`);
    }
  }

  // Gatekeepers: BASE_URL under the shared origin, shortName matches the router's path scan.
  const google = workers["gatekeeper-google"];
  assert.equal(google.kind, "gatekeeper");
  assert.equal(google.shortName, "google");
  assert.equal(google.vars.BASE_URL, "$PUBLIC_BASE_URL/gatekeeper/google");
  assert.ok(google.installable);
  assert.deepEqual(google.inputs?.map((i) => i.name), ["CLIENT_ID", "CLIENT_SECRET"]);
  assert.deepEqual(
      google.bindings.find((b) => b.name === "CLIENT_SECRET"),
      { type: "secret_text", name: "CLIENT_SECRET", text: "$SECRET(CLIENT_SECRET)" });

  // gatekeeper-email ships in the release but is not installable (needs Email Routing/a zone).
  assert.equal(workers["gatekeeper-email"].installable, false);
  assert.deepEqual(workers["gatekeeper-email"].inputs, []);

  // gatekeeper-context: closed-beta artifacts binding is cut; its KV is a normal template and
  // no OAuth-app inputs are demanded.
  const context = workers["gatekeeper-context"];
  assert.ok(!context.bindings.some((b) => b.name === "ARTIFACTS"));
  assert.deepEqual(
      context.bindings.find((b) => b.name === "CONTEXT_COLLECTIONS"),
      { type: "kv_namespace", name: "CONTEXT_COLLECTIONS",
        namespace_id: "$KV_CONTEXT_COLLECTIONS_ID" });
  assert.deepEqual(context.inputs, []);

  // Ambient gatekeepers are preinstalled on every core deploy; preinstalls must take no
  // secret inputs (nobody is around to supply them). Both also declare an account-level agent
  // singleton, so both are install-once.
  assert.equal(context.preinstall, true);
  assert.equal(context.singleton, true);
  assert.equal(workers["gatekeeper-scheduler"].preinstall, true);
  assert.equal(workers["gatekeeper-scheduler"].singleton, true);
  assert.deepEqual(workers["gatekeeper-scheduler"].inputs, []);
  assert.equal(google.preinstall, undefined);
  assert.equal(google.singleton, undefined);
  // Web Search is ambient and preinstalled too, and calls Workers AI through its own binding.
  const websearch = workers["gatekeeper-websearch"];
  assert.equal(websearch.preinstall, true);
  assert.equal(websearch.singleton, true);
  assert.deepEqual(websearch.inputs, []);
  assert.deepEqual(websearch.bindings, [{ type: "ai", name: "AI" }]);
  for (const [name, entry] of Object.entries(workers)) {
    if (entry.preinstall) {
      assert.ok(entry.installable, `${name}: preinstall requires installable`);
      assert.deepEqual(entry.inputs, [], `${name}: preinstall requires no inputs`);
    }
  }

  // The MCP connectors are install-once for SINGLETON's second reason: they take no inputs, so a
  // second install could not differ from the first — it would only mint a second vendor id.
  assert.equal(workers["gatekeeper-mcp"].singleton, true);
  assert.equal(workers["gatekeeper-mcp-portal"].singleton, true);
  assert.equal(workers["gatekeeper-homeassistant"].singleton, true);

  // The SchoolOS gatekeeper takes no OAuth credentials: the district verifies its own sign-in,
  // through a service binding the district deployment injects, so the release declares none.
  const schoolos = workers["gatekeeper-schoolos"];
  assert.deepEqual(schoolos.inputs, []);
  assert.equal(schoolos.singleton, true);
  assert.equal(schoolos.preinstall, undefined);
  assert.ok(!schoolos.bindings.some((b) => b.type === "service"));

  // Module blobs are content-addressed.
  for (const [name, entry] of Object.entries(workers)) {
    assert.ok(entry.modules.some((m) => m.name === entry.mainModule),
        `${name}: mainModule not in modules list`);
    for (const mod of entry.modules) {
      assert.equal(mod.r2Key, `blobs/modules/${mod.sha256}`);
    }
  }
});

// The deploy wizard sends a gatekeeper's manifest shortName as the install slug verbatim, and
// the slug becomes a GATEKEEPER_<SLUG> binding name, so the deploy service rejects anything
// outside this charset (packages/deploy/src/naming.ts). A shortName that fails here reaches
// customers as a redacted 500 on install with no workflow logs — fail the release build instead.
//
// releaseShortName() now throws on the same rule, so a bad package name fails inside
// generateManifest before it reaches these assertions. Deliberately restated rather than
// imported: this copy is the independent oracle that catches the constants there drifting from
// the deploy service's, which is the failure the generator's own check cannot see.
const SLUG_RE = /^[a-z][a-z0-9]*$/;
const MAX_SLUG_LEN = 20;

test("every gatekeeper shortName is a legal deploy slug", () => {
  const { workers } = buildTestManifest();
  for (const [name, entry] of Object.entries(workers)) {
    if (entry.kind !== "gatekeeper") continue;
    assert.match(entry.shortName ?? "", SLUG_RE,
        `${name}: shortName ${entry.shortName} is not a legal install slug; it must be ` +
        `lowercase letters and digits starting with a letter (it becomes GATEKEEPER_<SLUG>)`);
    assert.ok((entry.shortName ?? "").length <= MAX_SLUG_LEN,
        `${name}: shortName ${entry.shortName} exceeds ${MAX_SLUG_LEN} chars`);
    assert.equal(entry.vars.BASE_URL, `$PUBLIC_BASE_URL/gatekeeper/${entry.shortName}`,
        `${name}: BASE_URL path must match shortName`);
  }
});

// SINGLETON's second reason, as an invariant rather than a list: an installable gatekeeper that
// collects nothing from the wizard is configured identically on every install, so a second one
// adds no capability while splitting the vendor id its connections are recorded under
// (GATEKEEPER_<SLUG> -> `mcp2`). A new zero-input gatekeeper that genuinely wants two installs is
// a deliberate decision — make it here and in SINGLETON, not by accident.
test("installable gatekeepers that take no inputs are install-once", () => {
  for (const [name, entry] of Object.entries(buildTestManifest().workers)) {
    if (entry.kind !== "gatekeeper" || !entry.installable) continue;
    if ((entry.inputs ?? []).length > 0) continue;
    assert.equal(entry.singleton, true,
        `${name}: takes no deploy inputs, so a second install would be identical to the first ` +
        `except for its slug — add it to SINGLETON, or give it an input that distinguishes ` +
        `installs`);
  }
});

test("releaseShortName folds package names into the slug charset", () => {
  assert.equal(releaseShortName("gatekeeper-mcp-portal"), "mcpportal");
  // No-op for names that already conform.
  assert.equal(releaseShortName("gatekeeper-google"), "google");
});

// The fold only removes characters, so a name can fold to a remnant the charset still rejects.
// The deploy service would reject the install; the release build has to reject it first.
test("releaseShortName rejects names that don't fold to a legal slug", () => {
  for (const pkgName of [
    "gatekeeper-",                        // nothing left
    "gatekeeper---",                      // nothing left after the fold
    "gatekeeper-1password",               // digit-leading
    `gatekeeper-${"a".repeat(21)}`,       // over the 20-char cap
  ]) {
    assert.throws(() => releaseShortName(pkgName), /is not a legal install slug/,
        `expected ${pkgName} to be rejected`);
  }
  // The cap itself is inclusive.
  assert.equal(releaseShortName(`gatekeeper-${"a".repeat(20)}`), "a".repeat(20));
});

test("every gatekeeper shortName is unique", () => {
  const owners = new Map<string, string>();
  for (const [name, entry] of Object.entries(buildTestManifest().workers)) {
    if (entry.shortName === undefined) continue;
    const owner = owners.get(entry.shortName);
    assert.equal(owner, undefined,
        `${owner} and ${name} both emit shortName ${entry.shortName}`);
    owners.set(entry.shortName, name);
  }
});

// The fold is lossy — gatekeeper-foo-bar and gatekeeper-foobar both emit `foobar` — and two
// gatekeepers with the same slug would contend for one GATEKEEPER_<SLUG> binding and one
// /gatekeeper/<slug> route on every customer instance. Per-entry validity can't catch that.
test("generateManifest rejects gatekeepers whose folded shortNames collide", () => {
  const builds = readTestWorkerBuilds();
  const google = builds.find((w) => w.pkgName === "gatekeeper-google");
  assert.ok(google, "expected gatekeeper-google among the deployable packages");
  // Folds to "google" too, so it collides with gatekeeper-google.
  const collider = { ...google, pkgName: "gatekeeper-goo-gle" };

  assert.throws(() => buildTestManifest([...builds, collider]),
      /gatekeeper-google and gatekeeper-goo-gle both emit shortName "google"/);
});

test("per-package deploy-inputs.json files are well-formed when present", () => {
  const KINDS = new Set(["secret", "var", "workerName"]);
  for (const pkg of readDeployablePackages(join(ROOT, "packages"))) {
    const inputs = readDeployInputs(pkg.dir);
    if (inputs === undefined) continue;
    assert.ok(Array.isArray(inputs), `${pkg.name}/deploy-inputs.json must be an array`);
    for (const input of inputs) {
      assert.equal(typeof input.name, "string", `${pkg.name}: input.name`);
      assert.match(input.name, /^[A-Z][A-Z0-9_]*$/, `${pkg.name}: input name ${input.name}`);
      assert.ok(KINDS.has(input.kind), `${pkg.name}: input.kind ${input.kind}`);
      assert.equal(typeof input.label, "string", `${pkg.name}: input.label`);
      for (const key of Object.keys(input)) {
        assert.ok(["name", "kind", "label", "help", "consoleUrl", "setupSteps",
          "redirectUriTemplate"].includes(key), `${pkg.name}: unknown input key ${key}`);
      }
      if (input.setupSteps !== undefined) {
        assert.ok(Array.isArray(input.setupSteps) &&
            input.setupSteps.every((s) => typeof s === "string"),
            `${pkg.name}: setupSteps must be string[]`);
      }
    }
  }
});

// The `gatekeeper-` prefix means "gatekeeper", not "deployable": discovery keys on wrangler.jsonc
// alone, so a library may share it (`gatekeeper-kit` here, `gatekeeper-shared` internally). Pinned
// because the failure is otherwise indirect and puzzling — a stray wrangler.jsonc would make the
// kit a deployable, `workerKind` would type it a gatekeeper from its name, and the deploy wizard
// would demand CLIENT_ID/CLIENT_SECRET for a library before letting anyone install it.
test("a gatekeeper-prefixed library is not a deployable worker", () => {
  const deployable = readDeployablePackages(join(ROOT, "packages")).map((pkg) => pkg.name);
  assert.ok(!deployable.includes("gatekeeper-kit"),
      "gatekeeper-kit is a library; adding a wrangler.jsonc would publish it as a connector");
});

// A service is bound by the backend under a fixed name, never routed, so it must not pick up a
// gatekeeper's shortName, BASE_URL or OAuth default inputs (which would make it uninstallable).
test("a service package carries its backend binding and only its own inputs", () => {
  const builds = readTestWorkerBuilds();
  const guard = buildTestManifest(builds).workers["schoolos-ai-guard"];
  assert.ok(guard, "expected schoolos-ai-guard among the deployable packages");
  assert.equal(guard.kind, "service");
  assert.deepEqual(guard.backendBinding, { name: "AI_CALL_GUARD", entrypoint: "SchoolOsAiCallGuard" });
  assert.equal(guard.shortName, undefined);
  assert.equal(guard.vars.BASE_URL, undefined);
  assert.equal(guard.singleton, true);

  const withoutInputs = { ...builds.find((w) => w.pkgName === "schoolos-ai-guard")!, deployInputs: undefined };
  const entry = buildTestManifest([...builds.filter((w) => w.pkgName !== "schoolos-ai-guard"), withoutInputs])
      .workers["schoolos-ai-guard"];
  assert.deepEqual(entry?.inputs, []);
  assert.deepEqual(entry?.bindings, []);
});

// No deployable package declares D1 yet, so the golden file cannot show it. These pin the shape
// @schoolos/installer accepts (its D1Migration and `d1` binding schemas), which its own suite
// checks against a manifest generated here.
function d1Package(files: Record<string, string>, d1: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "manifest-lib-d1-"));
  mkdirSync(join(dir, "db"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, "db", name), sql);
  const config = {
    name: "schoolos-ai-guard",
    main: "src/index.ts",
    d1_databases: [{
      binding: "SCHOOLOS_DB", database_name: "local", database_id: "local-id", migrations_dir: "db",
      ...d1,
    }],
  };
  return { name: "schoolos-ai-guard", dir, config };
}

function d1Build(pkg: ReturnType<typeof d1Package>): WorkerBuild {
  const { mainModule, modules } = collectModules(join(TESTDATA, "fixture-bundles", "schoolos-ai-guard"));
  return { pkgName: pkg.name, config: pkg.config, mainModule, modules, d1Migrations: readD1Migrations(pkg) };
}

test("a D1 database becomes a $D1_<B>_ID binding and its migrations content-addressed blobs", () => {
  const pkg = d1Package({
    "0002_rosters.sql": "CREATE TABLE rosters (id TEXT PRIMARY KEY);\n",
    "0001_principals.sql": "CREATE TABLE principals (id TEXT PRIMARY KEY);\n",
    "README.md": "not a migration",
  });
  const entry = buildTestManifest([d1Build(pkg)]).workers["schoolos-ai-guard"];

  assert.deepEqual(entry.bindings.find((b) => b.type === "d1"),
      { type: "d1", name: "SCHOOLOS_DB", id: "$D1_SCHOOLOS_DB_ID" });
  assert.deepEqual(entry.d1Migrations?.map((m) => m.id), ["0001_principals", "0002_rosters"]);
  for (const migration of entry.d1Migrations ?? []) {
    const sql = readFileSync(join(pkg.dir, "db", `${migration.id}.sql`));
    assert.equal(migration.binding, "SCHOOLOS_DB");
    assert.equal(migration.size, sql.byteLength);
    assert.equal(migration.r2Key, `blobs/modules/${migration.sha256}`);
    assert.deepEqual(Object.keys(migration).toSorted(), ["binding", "id", "r2Key", "sha256", "size"]);
  }
  // Local-dev identifiers never reach a customer manifest.
  assert.doesNotMatch(JSON.stringify(entry), /local-id/);
});

test("workers without D1 carry no d1Migrations field, so existing manifests are unchanged", () => {
  for (const [name, entry] of Object.entries(buildTestManifest().workers)) {
    assert.equal("d1Migrations" in entry, false, `${name}: unexpected d1Migrations`);
  }
});

test("D1 migrations the installer would refuse fail the release build", () => {
  assert.throws(() => readD1Migrations(d1Package({ "1_init.sql": "SELECT 1;" })),
      /must be named NNNN_<lowercase_words>\.sql/);
  assert.throws(() => buildTestManifest([d1Build(d1Package({}, { remote: true }))]),
      /d1_databases\[SCHOOLOS_DB\] has key\(s\) this generator doesn't handle: remote/);

  const orphan = d1Build(d1Package({ "0001_init.sql": "SELECT 1;" }));
  orphan.d1Migrations = orphan.d1Migrations?.map((m) => ({ ...m, binding: "OTHER_DB" }));
  assert.throws(() => buildTestManifest([orphan]), /0001_init is for OTHER_DB, which it does not bind/);
});

// Cron Triggers pass through verbatim for the deploy service to schedule; any other trigger
// (routes, queues, email) is account-specific and fails closed until someone decides how.
test("a worker's Cron Triggers reach its manifest entry, and no other trigger is accepted", () => {
  const builds = readTestWorkerBuilds();
  assert.deepEqual(buildTestManifest(builds).workers["schoolos-ai-guard"]?.crons, ["17 3 * * *"]);
  assert.equal(buildTestManifest(builds).workers["gatekeeper-google"]?.crons, undefined);

  const guard = builds.find((w) => w.pkgName === "schoolos-ai-guard")!;
  const routed = { ...guard, config: { ...guard.config, triggers: { crons: [], routes: ["example.com/*"] } } };
  assert.throws(() => buildTestManifest([...builds.filter((w) => w !== guard), routed]),
      /trigger\(s\) this generator doesn't handle: routes/);
});
