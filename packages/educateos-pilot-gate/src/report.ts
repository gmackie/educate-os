// The pilot gate report: runs this package's suite through Vitest's Node API, joins each test's
// outcome with the criteria registry, and prints the G0/G1 report. `--write-doc` instead
// regenerates the traceability tables in docs/educateos/pilot-gate.md from the registry alone.
// Exits non-zero when a check fails or a registered test did not run.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startVitest } from "vitest/node";
import { renderGateReport, runIsBroken, withGeneratedTables, type TestOutcome, type TestResult } from "./traceability.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = fileURLToPath(new URL("../../../docs/educateos/pilot-gate.md", import.meta.url));

if (process.argv.includes("--write-doc")) {
  writeFileSync(DOC, withGeneratedTables(readFileSync(DOC, "utf8")));
  console.log(`Wrote the traceability tables to ${DOC}.`);
} else {
  // A reporter with no hooks keeps Vitest quiet; the gate report is the output.
  const vitest = await startVitest("test", [], { root: PACKAGE_ROOT, watch: false, reporters: [{}] });
  const results = new Map<string, TestResult>();
  for (const module of vitest.state.getTestModules()) {
    for (const test of module.children.allTests()) {
      results.set(test.fullName, {
        outcome: test.result().state as TestOutcome,
        annotations: test.annotations().map((annotation) => `${test.name}: ${annotation.message}`),
      });
    }
  }
  await vitest.close();
  console.log(renderGateReport(results));
  if (runIsBroken(results)) process.exitCode = 1;
}
