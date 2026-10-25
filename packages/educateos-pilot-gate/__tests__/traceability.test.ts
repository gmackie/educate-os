// The registry is the single source of the gate's traceability: these checks keep the test files
// and docs/educateos/pilot-gate.md in step with it.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRITERIA, checkFullName, criteriaForGate, declaredStatus } from "../src/criteria.ts";
import { renderGateReport, withGeneratedTables, type TestResult } from "../src/traceability.ts";

const TESTS = fileURLToPath(new URL(".", import.meta.url));
const DOC = fileURLToPath(new URL("../../../docs/educateos/pilot-gate.md", import.meta.url));

describe("the criteria registry", () => {
  it("covers every §14 row and every §3.4 exit criterion once, with unique check IDs", () => {
    expect(CRITERIA.filter((c) => c.source === "§14")).toHaveLength(17);
    expect(CRITERIA.filter((c) => c.source === "§3.4")).toHaveLength(10);
    expect(new Set(CRITERIA.map((c) => c.id)).size).toBe(CRITERIA.length);
    for (const criterion of CRITERIA) expect(new Set(criterion.checks.map((c) => c.id)).size, criterion.id).toBe(criterion.checks.length);
  });

  it("is registered by exactly the test file each criterion names", () => {
    const registered = new Map<string, string[]>();
    for (const file of readdirSync(TESTS).filter((name) => name.endsWith(".test.ts"))) {
      for (const [, id] of readFileSync(`${TESTS}${file}`, "utf8").matchAll(/^criterion\("([^"]+)"/gm)) {
        registered.set(id!, [...(registered.get(id!) ?? []), file]);
      }
    }
    expect(Object.fromEntries(registered)).toStrictEqual(Object.fromEntries(CRITERIA.map((c) => [c.id, [c.file]])));
  });

  it("keeps docs/educateos/pilot-gate.md's generated tables in step (pnpm --filter @educateos/pilot-gate write-doc)", () => {
    const document = readFileSync(DOC, "utf8");
    expect(document).toBe(withGeneratedTables(document));
  });

  it("keeps accessibility NOT MET until the UI packages land", () => {
    for (const id of ["s14.accessibility", "x34.accessible-flows", "h01.accessibility"]) {
      const criterion = CRITERIA.find((c) => c.id === id)!;
      expect(declaredStatus(criterion)).toBe("NOT MET");
      expect(criterion.gate).toBe("G1");
    }
  });
});

/** A run in which every registered test passed, except as `overrides` says. */
const passing = (overrides: Record<string, TestResult["outcome"]> = {}) => new Map<string, TestResult>(CRITERIA.flatMap((criterion) =>
  criterion.checks.flatMap((check) => {
    const name = checkFullName(criterion, check);
    return check.status === "test" ? [[name, { outcome: overrides[name] ?? "passed", annotations: [] }] as const] : [];
  })));

describe("the gate report", () => {
  it("meets a gate only when every criterion it requires passed in the run", () => {
    const report = renderGateReport(passing());
    expect(report).toMatch(/^G0 {2}.*: MET$/m);
    expect(report).toMatch(/^G1 {2}.*: NOT MET$/m);
    expect(criteriaForGate("G0").every((c) => declaredStatus(c) === "MET")).toBe(true);
  });

  it("reports a failed or missing check as NOT MET and says the run is broken", () => {
    const [criterion] = criteriaForGate("G0");
    const check = criterion!.checks[0]!;
    const failed = renderGateReport(passing({ [checkFullName(criterion!, check)]: "failed" }));
    expect(failed).toMatch(/^G0 {2}.*: NOT MET$/m);
    expect(failed).toContain(`fail    ${check.name}`);
    expect(failed).toContain("The run disagrees with the registry");
    const missing = passing();
    missing.delete(checkFullName(criterion!, check));
    expect(renderGateReport(missing)).toContain(`missing ${check.name}`);
  });
});
