// The district UI layout (scripts/production/assemble-district-ui.ts), over synthetic builds in a
// fresh temp directory per test (`node --test` runs files in parallel).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DISTRICT_UIS, assembleDistrictUi } from "./assemble-district-ui.ts";

/** A packages/ directory holding one built app per UI, each built for `bases[pkg]` or its own base. */
function packagesWithBuilds(bases: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "district-ui-"));
  for (const { pkg, base } of DISTRICT_UIS) {
    const built = bases[pkg] ?? base;
    mkdirSync(join(dir, pkg, "dist", "assets"), { recursive: true });
    writeFileSync(join(dir, pkg, "dist", "index.html"), `<script type="module" src="${built}assets/index-${pkg}.js"></script>`);
    writeFileSync(join(dir, pkg, "dist", "assets", `index-${pkg}.js`), pkg);
  }
  return dir;
}

test("lays the student app at the root and the others under their prefixes", () => {
  const packages = packagesWithBuilds();
  const out = join(packages, "out");
  mkdirSync(out);
  writeFileSync(join(out, "stale.txt"), "from an earlier deploy");
  assembleDistrictUi(packages, out);
  assert.match(readFileSync(join(out, "index.html"), "utf8"), /src="\/assets\/index-schoolos-student-ui\.js"/);
  assert.match(readFileSync(join(out, "admin", "index.html"), "utf8"), /src="\/admin\/assets\//);
  assert.equal(readFileSync(join(out, "teach", "assets", "index-schoolos-teacher-ui.js"), "utf8"), "schoolos-teacher-ui");
  assert.equal(existsSync(join(out, "stale.txt")), false);
});

test("refuses a UI built for the wrong prefix", () => {
  const packages = packagesWithBuilds({ "schoolos-admin-ui": "/" });
  assert.throws(() => assembleDistrictUi(packages, join(packages, "out")), /schoolos-admin-ui\/dist was not built for \/admin\//);
});

test("refuses a UI that is not built", () => {
  const packages = mkdtempSync(join(tmpdir(), "district-ui-"));
  assert.throws(() => assembleDistrictUi(packages, join(packages, "out")), /schoolos-student-ui is not built/);
});

test("refuses a student build with a file tree at another UI's prefix", () => {
  const packages = packagesWithBuilds();
  mkdirSync(join(packages, "schoolos-student-ui", "dist", "teach"));
  assert.throws(() => assembleDistrictUi(packages, join(packages, "out")), /has its own \/teach\//);
});
