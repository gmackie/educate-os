import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Run the same documented checks locally and in the workspace scripts suite.
for (const script of [
  "docs/educateos/examples/classroom-student-companion/boundary-check.mjs",
  "docs/educateos/examples/classroom-student-companion/client-check.mjs",
  "docs/educateos/clever-partner-demo/verify.mjs",
  "docs/educateos/clever-partner-demo/inventory.mjs",
  "docs/educateos/clever-partner-demo/build-bridge.mjs",
]) {
  test(script, () => {
    const result=spawnSync(process.execPath,[script,...(/inventory|build-bridge/.test(script) ? ["--check"] : [])],{encoding:"utf8"});
    assert.equal(result.status,0,result.stderr || result.stdout);
  });
}
