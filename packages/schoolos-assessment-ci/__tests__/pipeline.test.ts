import { describe, expect, it } from "vitest";
import type { AssessmentReport, CriterionEvidence, RunView } from "../src/index.ts";
import { ESSAY, LAB_CSV, P, PROBLEM_SET, threeSubjects } from "./setup.ts";

function teacherReport(view: RunView): AssessmentReport {
  if (view.view !== "teacher" || view.report === undefined) throw new Error(`expected a completed teacher view, got ${view.view} ${view.state}`);
  return view.report;
}

function evidenceOf(report: AssessmentReport, criterionId: string): CriterionEvidence[] {
  return report.criteria.find((c) => c.criterionId === criterionId)!.checks.flatMap((k) => k.evidence);
}

/** A report without what distinguishes one key from another. */
function withoutKey({ runId: _runId, key: { idempotencyKey: _key, ...key }, ...rest }: AssessmentReport) {
  return { key, ...rest };
}

/** The text each excerpt of `evidence` points at, in `text`. */
function quoted(text: string, evidence: CriterionEvidence): string[] {
  return evidence.excerpts.map((e) => text.slice(e.range.start, e.range.end));
}

describe("one pipeline across subjects (E02 acceptance)", () => {
  it("explains an English essay's structure, length and citations, citing the submitted text", async () => {
    const { ci, essay } = await threeSubjects();
    const report = teacherReport(await ci.run(P.rivera, { submissionId: essay.receipt.submissionId, idempotencyKey: "submitted" }));

    const [words, ...sections] = evidenceOf(report, "structure");
    expect(words).toMatchObject({ passed: true, score: 1 });
    expect(words!.observation).toMatch(/^\d+ words, not counting Works Cited$/);
    expect(sections.map((s) => s.passed)).toEqual([true, true, true]);
    expect(quoted(ESSAY, sections[1]!)).toEqual(["## Analysis"]);

    const [inText, otherStyle, references] = evidenceOf(report, "citations");
    expect(inText).toMatchObject({ observation: "3 in-text MLA citations", passed: true });
    expect(quoted(ESSAY, inText!)).toEqual(["(Wiesel 7)", "(Wiesel 34)", "(Smith 112)"]);
    // An APA-form citation in an MLA essay is evidence against the criterion, and says where.
    expect(otherStyle).toMatchObject({ observation: "1 in-text citation in APA form", passed: false });
    expect(quoted(ESSAY, otherStyle!)).toEqual(["(Lee, 2019)"]);
    expect(references).toMatchObject({ observation: "2 of 3 Works Cited entries in MLA form", passed: false });
    expect(references!.score).toBeCloseTo(2 / 3);
    expect(quoted(ESSAY, references!)).toEqual(["- Lee (2019) lecture notes"]);

    expect(evidenceOf(report, "content").map((e) => [e.observation, e.passed])).toEqual([["Names the author: present", true], ["Discusses silence: present", true]]);

    // Every criterion gets a suggestion labelled with the evaluator release that made it.
    expect(report.criteria.map((c) => c.suggestions.map((s) => [`${s.evaluator.id}@${s.evaluator.release}`, s.levelId]))).toEqual([
      [["writing.structure@1.0.0", "proficient"]],
      // Two of three findings passed, plus a two-thirds score: below "mostly correct" (2 of 3 points).
      [["citation.format@1.0.0", "partial"]],
      [["content.required@1.0.0", "yes"]],
    ]);
    expect(report.summary).toMatchObject({ criteria: 3, checks: 3, passed: 7, failed: 2, observations: 0 });
    expect(report.costUsdNano).toBe("0");
  });

  it("explains a Biology lab CSV's columns, units and computed mean against a fixture", async () => {
    const { ci, lab } = await threeSubjects();
    const report = teacherReport(await ci.run(P.morgan, { submissionId: lab.receipt.submissionId, idempotencyKey: "submitted" }));

    const quality = evidenceOf(report, "data-quality");
    expect(quality.map((e) => [e.observation, e.passed])).toEqual([
      ["Temperature (°C): as expected", true],
      ["Mass (g): as expected", true],
      ["Time (s): as expected", true],
      ["4 columns in every row", true],
      ["4 data rows", true],
      ["Trial: no empty or repeated keys", true],
      ["Mass (g): no values that are not numbers", true],
      ["Time (s): no values that are not numbers", true],
    ]);
    expect(quoted(LAB_CSV, quality[1]!)).toEqual(["Trial,Temperature (°C),Mass (g),Time (s)"]);

    const [mean] = evidenceOf(report, "analysis");
    expect(mean).toMatchObject({ observation: "mean of Mass (g) is 5.175", passed: true });
    expect(mean!.explanation).toContain("within tolerance");
    expect(report.evaluatorReleases.map((r) => r.id)).toEqual(["dataset.structure", "spreadsheet.assertions", "spreadsheet.computed-value"]);
  });

  it("checks a math problem set against an answer key, rejecting an answer that is code", async () => {
    const { ci, math } = await threeSubjects();
    const report = teacherReport(await ci.run(P.patel, { submissionId: math.receipt.submissionId, idempotencyKey: "submitted" }));

    const answers = evidenceOf(report, "answers");
    expect(answers.map((e) => [e.observation, e.passed])).toEqual([
      ["Problem 1: correct", true],
      ["Problem 2: correct", true],
      ["Problem 3: correct", true],
      ["Problem 4: incorrect", false],
      ["Problem 5: answer not readable", false],
    ]);
    expect(answers.map((e) => quoted(PROBLEM_SET, e))).toEqual([["3/4"], ["2^3 - 1"], ["0.333"], ["4"], ["process.exit(1)"]]);
    expect(answers[3]!.explanation).toBe('The answer "4" is 4; the key is 17/4 (4.25).');
    expect(answers[4]!.explanation).toMatch(/^"process.exit\(1\)" is not a number or arithmetic expression: Unexpected "p"/);
    // Three of five: three points.
    expect(report.criteria[0]!.suggestions).toEqual([{ evaluator: { id: "math.answers", release: "1.0.0" }, levelId: "p3", points: 3, maxPoints: 5 }]);
  });

  it("is deterministic: the same work gives the same report under every key", async () => {
    const { ci, essay, lab, math } = await threeSubjects();
    for (const [teacher, submission] of [[P.rivera, essay], [P.morgan, lab], [P.patel, math]] as const) {
      const first = teacherReport(await ci.run(teacher, { submissionId: submission.receipt.submissionId, idempotencyKey: "first" }));
      const second = teacherReport(await ci.run(teacher, { submissionId: submission.receipt.submissionId, idempotencyKey: "second" }));
      expect(second.runId).not.toBe(first.runId);
      expect(JSON.stringify(withoutKey(second))).toBe(JSON.stringify(withoutKey(first)));
      expect(second.stepsUsed).toBe(first.stepsUsed);
    }
  });
});
