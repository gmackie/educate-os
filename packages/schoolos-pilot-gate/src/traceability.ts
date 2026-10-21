// Renders the criteria registry: the traceability tables in docs/schoolos/pilot-gate.md, and the
// gate report, which joins the registry with one run of the suite.
import {
  blockersOf,
  checkFullName,
  CRITERIA,
  criteriaForGate,
  declaredStatus,
  Gate,
  type Check,
  type Criterion,
} from "./criteria.ts";

/** What one run reported for a test, by its full name. */
export type TestOutcome = "passed" | "failed" | "skipped" | "pending";

/** One test's outcome in a run, and any annotations it recorded. */
export interface TestResult {
  outcome: TestOutcome;
  annotations: readonly string[];
}

/** A check's status in a run. A test check that did not run at all is `missing`. */
export type CheckStatus = "pass" | "fail" | "missing" | "todo";

/** A criterion's status in a run: met only if every check passed. */
export type LiveStatus = "MET" | "NOT MET";

/** Where the generated part of docs/schoolos/pilot-gate.md begins. */
export const DOC_BEGIN = "<!-- BEGIN GENERATED: pnpm --filter @schoolos/pilot-gate write-doc -->";
/** Where it ends. */
export const DOC_END = "<!-- END GENERATED -->";

const GATE_NAMES: Record<Gate, string> = {
  G0: "Architectural runnable harness",
  G1: "SchoolOS classroom product (synthetic)",
  G2: "Self-service district setup (sandbox account)",
  G3: "Guided educator pilot",
  G4: "Interoperability and broader rollout",
};

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function checkLine(check: Check): string {
  if (check.status === "todo") return `todo: ${check.name} (${check.blockedBy.join(", ")})`;
  return `test: ${check.name}${check.direct === undefined ? "" : " (direct)"}`;
}

/** The traceability tables, as Markdown: every criterion, its checks, file, status and blockers. */
export function renderTraceabilityTables(criteria: readonly Criterion[] = CRITERIA): string {
  const lines: string[] = [];
  for (const source of ["§14", "§3.4", "H01"] as const) {
    const rows = criteria.filter((c) => c.source === source);
    lines.push(`### ${source === "H01" ? "H01 additions" : `Roadmap ${source}`}`, "");
    lines.push("| Row | Expected | Gate | Checks | Test file | Status | Blocked by |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const criterion of rows) {
      const blockers = blockersOf(criterion);
      lines.push(`| ${[
        cell(criterion.title),
        cell(criterion.expected),
        criterion.gate,
        criterion.checks.map((check) => cell(checkLine(check))).join("<br>"),
        `\`${criterion.file}\``,
        `**${declaredStatus(criterion)}**`,
        blockers.length === 0 ? "" : blockers.join(", "),
      ].join(" | ")} |`);
    }
    lines.push("");
  }
  const direct = criteria.flatMap((criterion) => criterion.checks.flatMap((check) => (check.status === "test" && check.direct !== undefined ? [{ criterion, check, why: check.direct }] : [])));
  lines.push("### Checks that call a domain package directly", "");
  lines.push("| Row | Check | Why not over HTTP |", "| --- | --- | --- |");
  for (const { criterion, check, why } of direct) lines.push(`| ${cell(criterion.title)} | ${cell(check.name)} | ${cell(why)} |`);
  lines.push("");
  const counts = Gate.options.map((gate) => {
    const own = criteria.filter((c) => c.gate === gate);
    return `| ${gate} | ${own.length} | ${own.filter((c) => declaredStatus(c) === "MET").length} | ${own.filter((c) => declaredStatus(c) === "NOT MET").length} |`;
  });
  lines.push("### Criteria by the gate that first requires them", "", "| Gate | Criteria | MET | NOT MET |", "| --- | --- | --- | --- |", ...counts, "");
  return lines.join("\n");
}

/** Replaces the generated part of the document with freshly rendered tables. */
export function withGeneratedTables(document: string): string {
  const begin = document.indexOf(DOC_BEGIN);
  const end = document.indexOf(DOC_END);
  if (begin < 0 || end < begin) throw new Error("docs/schoolos/pilot-gate.md has no generated section markers");
  return `${document.slice(0, begin + DOC_BEGIN.length)}\n\n${renderTraceabilityTables()}\n${document.slice(end)}`;
}

/** A check's status, given what the run reported. */
export function checkStatus(criterion: Criterion, check: Check, results: ReadonlyMap<string, TestResult>): CheckStatus {
  if (check.status === "todo") return "todo";
  const result = results.get(checkFullName(criterion, check));
  if (result === undefined) return "missing";
  return result.outcome === "passed" ? "pass" : result.outcome === "failed" ? "fail" : "missing";
}

/** A criterion's status, given what the run reported. */
export function liveStatus(criterion: Criterion, results: ReadonlyMap<string, TestResult>): LiveStatus {
  return criterion.checks.every((check) => checkStatus(criterion, check, results) === "pass") ? "MET" : "NOT MET";
}

/** Whether the run disagrees with the registry: a test check failed or never ran. */
export function runIsBroken(results: ReadonlyMap<string, TestResult>): boolean {
  return CRITERIA.some((criterion) => criterion.checks.some((check) => ["fail", "missing"].includes(checkStatus(criterion, check, results))));
}

function gateSummary(gate: Gate, criteria: readonly Criterion[], results: ReadonlyMap<string, TestResult>): string[] {
  const statuses = criteria.flatMap((criterion) => criterion.checks.map((check) => checkStatus(criterion, check, results)));
  const notMet = criteria.filter((criterion) => liveStatus(criterion, results) === "NOT MET");
  const verdict = notMet.length === 0 ? "MET" : "NOT MET";
  const lines = [
    `${gate}  ${GATE_NAMES[gate]}: ${verdict}`,
    `    criteria: ${criteria.length - notMet.length} met, ${notMet.length} not met (of ${criteria.length})`,
    `    checks:   ${statuses.filter((s) => s === "pass").length} pass, ${statuses.filter((s) => s === "todo").length} todo, ${statuses.filter((s) => s === "fail").length} fail, ${statuses.filter((s) => s === "missing").length} missing`,
  ];
  for (const criterion of notMet) {
    lines.push(`    NOT MET  ${criterion.source} ${criterion.title}`);
    for (const check of criterion.checks) {
      const status = checkStatus(criterion, check, results);
      if (status === "pass") continue;
      lines.push(`               ${status.padEnd(7)} ${check.name}${check.status === "todo" ? ` [${check.blockedBy.join(", ")}]` : ""}`);
    }
  }
  return lines;
}

/** The G0/G1 gate report for one run of the suite, with later gates summarized. */
export function renderGateReport(results: ReadonlyMap<string, TestResult>): string {
  const lines = ["SchoolOS synthetic pilot gate (roadmap H01, SCHO-34)", ""];
  lines.push(...gateSummary("G0", criteriaForGate("G0"), results), "");
  lines.push(...gateSummary("G1", criteriaForGate("G1"), results), "");
  lines.push("Later gates (criteria this suite already carries):");
  for (const gate of ["G2", "G3", "G4"] as const) {
    const own = CRITERIA.filter((c) => c.gate === gate);
    const met = own.filter((c) => liveStatus(c, results) === "MET").length;
    lines.push(`    ${gate}  ${GATE_NAMES[gate]}: ${met} of ${own.length} of its own criteria met`);
  }
  const notes = CRITERIA.flatMap((criterion) => criterion.checks.flatMap((check) => results.get(checkFullName(criterion, check))?.annotations ?? []));
  if (notes.length > 0) lines.push("", "Informational (not gate criteria):", ...notes.map((note) => `    ${note}`));
  if (runIsBroken(results)) lines.push("", "The run disagrees with the registry: a check failed or did not run. Fix the suite before reading this report.");
  return lines.join("\n");
}
