import { describe, expect, it } from "vitest";
import { builtinRegistry, signRubricRelease, studentRubricView } from "../src/index.ts";
import { NOW, P, labRubric, mathRubric, rejectsWith, threeSubjects } from "./setup.ts";

/** Values from the teacher-only fixtures that must never reach a student. */
const FIXTURES = ["17/4", "4.25", "5.175", "1/3", "Discusses silence", "math.answers", "spreadsheet.computed-value", "content.required"];

function expectNoFixture(value: unknown): void {
  const json = JSON.stringify(value);
  for (const fixture of FIXTURES) expect(json, fixture).not.toContain(fixture);
}

describe("student-visible and teacher-only checks", () => {
  it("refuses to bind an answer-keyed evaluator as student-visible", async () => {
    const math = mathRubric();
    math.criteria[0]!.checks[0]!.visibility = "student-visible";
    await rejectsWith(signRubricRelease(math, P.patel, builtinRegistry(), NOW), "policy-violation");
    const lab = labRubric();
    lab.criteria[1]!.checks[0]!.visibility = "student-visible";
    await rejectsWith(signRubricRelease(lab, P.morgan, builtinRegistry(), NOW), "policy-violation");
  });

  it("shows the student only student-visible evidence, with no suggested scores", async () => {
    const { ci, essay } = await threeSubjects();
    const view = await ci.run(P.amara, { submissionId: essay.receipt.submissionId, idempotencyKey: "submitted" });
    expect(view.view).toBe("student");
    if (view.view !== "student") return;
    expect(view.report?.criteria.map((c) => c.criterionId)).toEqual(["structure", "citations"]);
    expect(view.report?.criteria.flatMap((c) => c.checks.map((k) => k.visibility))).toEqual(["student-visible", "student-visible"]);
    expect(JSON.stringify(view)).not.toContain("suggestions");
    expect(view.report?.summary.text).toBe("5 of 7 findings passed across 2 checks on 2 criteria.");
    expectNoFixture(view);

    // The teacher sees the same run whole.
    const teacher = await ci.view(P.rivera, essay.receipt.submissionId, view.runId);
    expect(teacher.view === "teacher" && teacher.report?.criteria.map((c) => c.criterionId)).toEqual(["structure", "citations", "content"]);
  });

  it("never lets answer keys or fixtures reach the student, their workspace or their feedback", async () => {
    const env = await threeSubjects();
    for (const [teacher, student, submission] of [[P.patel, P.chidi, env.math], [P.morgan, P.amara, env.lab]] as const) {
      const submissionId = submission.receipt.submissionId;
      // The student may run CI on their own work, and sees the student view of it.
      const own = await env.ci.run(student, { submissionId, idempotencyKey: "student-check" });
      expect(own.view).toBe("student");
      expectNoFixture(own);
      const teacherRun = await env.ci.run(teacher, { submissionId, idempotencyKey: "submitted" });
      expectNoFixture(await env.ci.view(student, submissionId, teacherRun.runId));

      // The rubric as the student sees it carries no configs.
      expectNoFixture(studentRubricView(submission.release));

      // Suggestions reach feedback, but the student never sees them.
      await env.ci.suggestScores(teacher, submissionId, teacherRun.runId);
      await env.assessment.advanceFeedback(teacher, submissionId, "shared-with-student");
      const feedback = await env.assessment.getFeedback(student, submissionId);
      expect(feedback.scores).toEqual([]);
      expectNoFixture(feedback);

      // Nothing was written to the student's workspace.
      const files = await env.artifacts.listArtifacts(student, submission.workspaceId as never);
      expect(files.map((f) => f.artifact.id)).toEqual(submission.artifacts.map((a) => a.artifact.id));
      for (const file of files) expectNoFixture(await env.artifacts.readRevision(student, file.artifact.id, file.head.id));
    }
  });

  it("does not tell the student why a run failed, which could name teacher-only checks", async () => {
    const env = await threeSubjects();
    const { ci } = env.ciWith({ profiles: [{ id: "tiny@1", kind: "deterministic", limits: { maxSteps: 10, maxInputBytes: 10_000, maxRetries: 0, maxCostCents: 0 } }] });
    const submissionId = env.math.receipt.submissionId;
    const own = await ci.run(P.chidi, { submissionId, idempotencyKey: "k", executionProfile: "tiny@1" });
    expect(own).toEqual({ view: "student", runId: own.runId, state: "failed", failed: true });
    const teacher = await ci.view(P.patel, submissionId, own.runId);
    expect(teacher.view === "teacher" && teacher.error?.code).toBe("step-budget-exceeded");
  });

  it("keeps runs from anyone who cannot read the submission", async () => {
    const { ci, essay, math } = await threeSubjects();
    const run = await ci.run(P.rivera, { submissionId: essay.receipt.submissionId, idempotencyKey: "submitted" });
    await rejectsWith(ci.run(P.elena, { submissionId: essay.receipt.submissionId, idempotencyKey: "probe" }), "not-found");
    await rejectsWith(ci.view(P.elena, essay.receipt.submissionId, run.runId), "not-found");
    // A run is reachable only through the submission it assessed.
    await rejectsWith(ci.view(P.patel, math.receipt.submissionId, run.runId), "not-found");
  });
});
