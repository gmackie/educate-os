// The watched paths ForgeGraph reads to skip unchanged Worker deploys (scripts/production/watch-paths.ts):
// the committed file must be current, and each list must cover everything the build can read.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPOSITORY_INPUTS, ROOT, WATCHED_TARGETS, WATCH_PATHS_FILE, loadWorkspace, renderWatchPaths } from "./watch-paths.ts";

const ws = loadWorkspace();
const committed = JSON.parse(readFileSync(join(ROOT, WATCH_PATHS_FILE), "utf8")) as Record<string, string[]>;

test("the committed file is current", () => {
  assert.equal(readFileSync(join(ROOT, WATCH_PATHS_FILE), "utf8"), renderWatchPaths(ws));
});

test("every watched target has a list and nothing else does", () => {
  assert.deepEqual(Object.keys(committed).toSorted(), Object.keys(WATCHED_TARGETS).toSorted());
});

test("each list covers the repository inputs, its roots, its build scripts and the scripts manifest", () => {
  for (const [name, target] of Object.entries(WATCHED_TARGETS)) {
    const paths = committed[name]!;
    for (const path of [...REPOSITORY_INPUTS, ...target.roots.map((dir) => `${dir}/`), ...target.scripts, "scripts/package.json"]) {
      assert.ok(paths.includes(path), `${name} must watch ${path}`);
    }
  }
});

test("each list covers every workspace package its roots depend on, transitively", () => {
  for (const [name, target] of Object.entries(WATCHED_TARGETS)) {
    const paths = new Set(committed[name]);
    const pending = [...target.roots];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const dir = pending.pop()!;
      if (seen.has(dir) || dir === "scripts") continue;
      seen.add(dir);
      assert.ok(paths.has(`${dir}/`), `${name} must watch ${dir}/`);
      const pkg = ws.manifests.get(dir) ?? {};
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dep of Object.keys((pkg[field] as Record<string, string> | undefined) ?? {})) {
          const depDir = ws.dirs.get(dep);
          if (depDir) pending.push(depDir);
        }
      }
    }
  }
});

test("a relative import into another package is watched", () => {
  // sites/educateos-io imports the control plane by path, not by package name.
  assert.ok(committed["educateos-site"]!.includes("packages/educateos-control-plane/"));
});

test("the configurator build a connector runs is watched with what it imports", () => {
  const google = committed["gatekeeper-google"]!;
  assert.ok(google.includes("scripts/build-gatekeeper-configurator.ts"));
  assert.ok(google.includes("packages/configurator-ui/"));
});

test("operator-only scripts are not watched by a connector", () => {
  const google = committed["gatekeeper-google"]!;
  assert.ok(!google.some((path) => path.startsWith("scripts/evals/") || path.startsWith("scripts/marketplace/")));
  assert.ok(!google.includes("packages/educateos-district-worker/"));
});

test("every path is repository-relative", () => {
  for (const paths of Object.values(committed)) {
    for (const path of paths) assert.ok(!path.startsWith("/") && !path.split("/").includes(".."), path);
  }
});
