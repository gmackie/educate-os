// The deploy-time commit stamp (scripts/production/stamp-commit.ts), against the committed
// production configs: each must take the stamp and stay valid JSONC with everything else intact.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { PACKAGES_DIR } from "../preview/staging-config.ts";
import { PRODUCTION_CONFIG_NAME, productionPackageNames } from "./production-config.ts";
import { SCHOOLOS_GMAC_IO } from "./schoolos-gmac-io.ts";
import { COMMIT_VAR, stampCommit } from "./stamp-commit.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("every committed production config takes the stamp and keeps its other settings", () => {
  for (const pkgName of productionPackageNames(SCHOOLOS_GMAC_IO)) {
    const text = readFileSync(join(PACKAGES_DIR, pkgName, PRODUCTION_CONFIG_NAME), "utf8");
    const before = parse(text);
    assert.equal(before.vars?.[COMMIT_VAR], undefined, `${pkgName}: a committed config must not name a commit`);
    const after = parse(stampCommit(text, COMMIT));
    assert.equal(after.vars[COMMIT_VAR], COMMIT, pkgName);
    delete after.vars[COMMIT_VAR];
    if (before.vars === undefined && Object.keys(after.vars).length === 0) delete after.vars;
    assert.deepEqual(after, before, pkgName);
  }
});

test("a config with no vars gains a vars block", () => {
  assert.deepEqual(parse(stampCommit('// header\n{ "name": "w" }\n', COMMIT)), { name: "w", vars: { [COMMIT_VAR]: COMMIT } });
});

test("stamping twice with the same commit is a no-op", () => {
  const once = stampCommit('{ "name": "w", "vars": { "A": "1" } }', COMMIT);
  assert.equal(stampCommit(once, COMMIT), once);
});

test("refuses a short or non-hex commit", () => {
  for (const bad of ["", "abc123", COMMIT.toUpperCase(), `${COMMIT}\n`]) {
    assert.throws(() => stampCommit('{ "name": "w" }', bad), /not a full commit SHA/);
  }
});

test("refuses a config that already names another commit", () => {
  const other = "f".repeat(40);
  assert.throws(() => stampCommit(`{ "vars": { "${COMMIT_VAR}": "${other}" } }`, COMMIT), /already names commit/);
});

test("refuses text that is not JSONC", () => {
  assert.throws(() => stampCommit("{ name: ", COMMIT), /not valid JSONC/);
});
