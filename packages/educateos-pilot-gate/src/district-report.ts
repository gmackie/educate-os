// The per-district gate report (SCHO-205): joins the scenario registry with one run of the district
// suite (in process) or of the live probes (against a deployed district), and renders it as a
// Markdown table and a JSON document, one row per scenario and one column per district.
import type { DemoDistrict } from "@educateos/fixtures";
import { cells, SCENARIOS, scenarioFullName, type Applicability, type Scenario } from "./districts.ts";
import type { TestResult } from "./traceability.ts";

/**
 * A cell's status. `MET`: its test passed in this run. `NOT MET`: it applies and runs, and failed or
 * did not run. `NOT YET APPLICABLE`: it applies, but waits on an unmerged issue. `NOT IN PROFILE`:
 * the district has no such integration.
 */
export type CellStatus = "MET" | "NOT MET" | "NOT YET APPLICABLE" | "NOT IN PROFILE";

/** One district × scenario cell of a report. */
export interface ReportCell {
  district: DemoDistrict["slug"];
  scenario: string;
  status: CellStatus;
  /** For NOT YET APPLICABLE: the issues it waits on. */
  blockedBy?: readonly string[];
  /** Why it is not yet applicable, or why a run failed. */
  note?: string;
  /** Set when the scenario calls a domain package rather than the district app over HTTP. */
  direct?: string;
}

/** A whole report: where it ran and every cell. */
export interface DistrictReport {
  /** `in-process`, or the live origin it probed. */
  target: string;
  /** When the run finished, ISO 8601. */
  generatedAt: string;
  /** The source revision, when known (CI sets it). */
  revision?: string;
  cells: ReportCell[];
}

/** A cell's status from its applicability and, when it runs, the run's result for it. */
export function cellStatus(applicability: Applicability, result: TestResult | undefined): CellStatus {
  if (applicability.kind === "not-in-profile") return "NOT IN PROFILE";
  if (applicability.kind === "blocked") return "NOT YET APPLICABLE";
  return result?.outcome === "passed" ? "MET" : "NOT MET";
}

/** The in-process report: the registry joined with a run of the `__tests__/districts.<slug>.test.ts` files, by full test name. */
export function inProcessReport(results: ReadonlyMap<string, TestResult & { error?: string }>, meta: { generatedAt: string; revision?: string }): DistrictReport {
  return {
    target: "in-process",
    ...meta,
    cells: cells().map(({ demo, scenario, applicability }) => {
      const result = results.get(scenarioFullName(demo, scenario));
      const status = cellStatus(applicability, result);
      return {
        district: demo.slug,
        scenario: scenario.id,
        status,
        ...(applicability.kind === "blocked" ? { blockedBy: applicability.blockedBy, note: applicability.reason } : {}),
        ...(applicability.kind === "runs" && applicability.direct !== undefined ? { direct: applicability.direct } : {}),
        ...(status === "NOT MET" ? { note: result === undefined ? "did not run" : (result.error ?? result.outcome) } : {}),
      };
    }),
  };
}

/** Whether a report fails the gate: some cell that applies and runs is NOT MET. */
export function reportFails(report: DistrictReport): boolean {
  return report.cells.some((c) => c.status === "NOT MET");
}

const SHORT: Record<CellStatus, string> = { MET: "MET", "NOT MET": "**NOT MET**", "NOT YET APPLICABLE": "NYA", "NOT IN PROFILE": "—" };

const escape = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** The report as Markdown: a summary per district, the district × scenario table, and the notes behind each non-MET cell. */
export function renderDistrictReport(report: DistrictReport, scenarios: readonly Pick<Scenario, "id" | "title">[] = SCENARIOS): string {
  const districts = [...new Set(report.cells.map((c) => c.district))];
  const cell = (district: string, scenario: string) => report.cells.find((c) => c.district === district && c.scenario === scenario);
  const lines = [
    `# District validation report (${report.target})`,
    "",
    `Generated ${report.generatedAt}${report.revision === undefined ? "" : ` at ${report.revision}`}. MET: passed in this run. **NOT MET**: applies and failed or did not run. NYA: not yet applicable, waiting on the issue named below. —: not in the district's integration profile.`,
    "",
    "| District | Gate | MET | NOT MET | NYA | Not in profile |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const district of districts) {
    const own = report.cells.filter((c) => c.district === district);
    const count = (status: CellStatus) => own.filter((c) => c.status === status).length;
    lines.push(`| ${district} | ${count("NOT MET") > 0 ? "**NOT MET**" : "MET"} | ${count("MET")} | ${count("NOT MET")} | ${count("NOT YET APPLICABLE")} | ${count("NOT IN PROFILE")} |`);
  }
  lines.push("", `| Scenario | ${districts.join(" | ")} |`, `| --- | ${districts.map(() => "---").join(" | ")} |`);
  for (const scenario of scenarios) {
    if (!report.cells.some((c) => c.scenario === scenario.id)) continue;
    const row = districts.map((district) => {
      const c = cell(district, scenario.id);
      if (c === undefined) return "";
      return c.status === "NOT YET APPLICABLE" ? `NYA (${c.blockedBy?.join(", ")})` : SHORT[c.status];
    });
    lines.push(`| \`${scenario.id}\` | ${row.join(" | ")} |`);
  }
  const notes = report.cells.filter((c) => c.note !== undefined && c.status !== "MET");
  if (notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const c of notes) lines.push(`- **${c.district} / ${c.scenario}** (${c.status}${c.blockedBy === undefined ? "" : `, ${c.blockedBy.join(", ")}`}): ${escape(c.note!)}`);
  }
  lines.push("", "## Scenarios", "");
  for (const scenario of scenarios) {
    const direct = report.cells.find((c) => c.scenario === scenario.id && c.direct !== undefined)?.direct;
    lines.push(`- \`${scenario.id}\`: ${escape(scenario.title)}${direct === undefined ? "" : ` _Direct: ${escape(direct)}_`}`);
  }
  if (reportFails(report)) lines.push("", "The gate is NOT MET: a scenario that applies and runs failed or did not run.");
  return `${lines.join("\n")}\n`;
}
