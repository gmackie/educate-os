// The district validation suite's runner (SCHO-205). In process (the default) it runs the district
// files (`__tests__/districts.<slug>.test.ts`) through Vitest's Node API, as `report.ts` runs the
// pilot gate, and joins the outcome with the scenario registry. With `--target https://<slug>.educateos.io` it
// probes that deployed district read-only instead (`live.ts`). Either way it prints the per-district
// gate report and, with `--out <dir>`, writes it there as `district-report.md` and
// `district-report.json` (the CI artifact), stamped with `--revision <sha>` when given. Exits
// non-zero when a cell that applies and runs is NOT MET.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startVitest } from "vitest/node";
import { inProcessReport, renderDistrictReport, reportFails, type DistrictReport } from "./district-report.ts";
import { SCENARIOS } from "./districts.ts";
import { LIVE_PROBES, liveReport, serviceTokenFromEnv } from "./live.ts";
import type { TestOutcome, TestResult } from "./traceability.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const { values } = parseArgs({ options: { target: { type: "string" }, out: { type: "string" }, revision: { type: "string" } } });
const meta = { generatedAt: new Date().toISOString(), ...(values.revision === undefined ? {} : { revision: values.revision }) };

let report: DistrictReport;
let scenarios: readonly { id: string; title: string }[] = SCENARIOS;
if (values.target !== undefined) {
  const serviceToken = serviceTokenFromEnv(process.env);
  report = await liveReport({ target: values.target, ...(serviceToken === undefined ? {} : { serviceToken }), ...meta });
  scenarios = [...LIVE_PROBES, ...SCENARIOS];
} else {
  // A reporter with no hooks keeps Vitest quiet; the report is the output.
  const vitest = await startVitest("test", ["__tests__/districts."], { root: PACKAGE_ROOT, watch: false, reporters: [{}] });
  const results = new Map<string, TestResult & { error?: string }>();
  for (const module of vitest.state.getTestModules()) {
    // A district file that failed to load runs none of its tests; say why on each of its cells.
    const loadError = module.errors()[0]?.message;
    if (loadError !== undefined) console.error(`${module.moduleId}: ${loadError}`);
    for (const test of module.children.allTests()) {
      const result = test.result();
      const error = result.errors?.[0]?.message;
      results.set(test.fullName, { outcome: result.state as TestOutcome, annotations: [], ...(error === undefined ? {} : { error }) });
    }
  }
  const unhandled = vitest.state.getUnhandledErrors();
  await vitest.close();
  report = inProcessReport(results, meta);
  if (unhandled.length > 0) {
    console.error(`${unhandled.length} unhandled error(s) during the run`);
    process.exitCode = 1;
  }
}

const markdown = renderDistrictReport(report, scenarios);
console.log(markdown);
if (values.out !== undefined) {
  const dir = resolve(values.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "district-report.md"), markdown);
  writeFileSync(join(dir, "district-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote district-report.md and district-report.json to ${dir}.`);
}
if (reportFails(report)) process.exitCode = 1;
