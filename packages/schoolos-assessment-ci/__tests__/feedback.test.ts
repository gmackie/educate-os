import { describe, expect, it } from "vitest";
import { P, rejectsWith, threeSubjects } from "./setup.ts";

describe("results to feedback", () => {
  it("posts suggested criterion scores labelled with the evaluator release", async () => {
    const { ci, assessment, essay } = await threeSubjects();
    const submissionId = essay.receipt.submissionId;
    const run = await ci.run(P.rivera, { submissionId, idempotencyKey: "submitted" });
    const posted = await ci.suggestScores(P.rivera, submissionId, run.runId);

    expect(posted.map((s) => [s.criterionId, s.points, s.maxPoints, s.source])).toEqual([
      ["structure", 4, 4, { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "writing.structure@1.0.0" } }],
      ["citations", 1, 3, { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "citation.format@1.0.0" } }],
      ["content", 2, 2, { kind: "suggested", suggester: { kind: "evaluator", evaluatorId: "content.required@1.0.0" } }],
    ]);
    // Posting again replaces each suggestion rather than adding another.
    await ci.suggestScores(P.rivera, submissionId, run.runId);
    expect((await assessment.getFeedback(P.rivera, submissionId)).scores).toHaveLength(3);
  });

  it("never makes a suggestion official: the grade gate still needs the teacher", async () => {
    const { ci, assessment, math } = await threeSubjects();
    const submissionId = math.receipt.submissionId;
    const run = await ci.run(P.patel, { submissionId, idempotencyKey: "submitted" });
    const submission = await assessment.getSubmission(P.patel, submissionId);
    // Posted through a tool, the scores are still only suggestions.
    const [suggested] = await ci.suggestScores({ ...P.patel, channel: "mcp-tool" }, submissionId, run.runId);
    expect(suggested).toMatchObject({ points: 3, maxPoints: 5, source: { kind: "suggested" } });
    expect(await assessment.officialGrades(P.patel, submission.assignmentId, submission.studentPrincipalId)).toEqual([]);

    // A tool that writes the suggested score as a grade only proposes it.
    const proposed = await assessment.recordOfficialGrade({ ...P.patel, channel: "mcp-tool" }, { submissionId, score: { points: 3, maxPoints: 5 } });
    expect(proposed.status).toBe("pending-approval");
    expect(await assessment.officialGrades(P.patel, submission.assignmentId, submission.studentPrincipalId)).toEqual([]);

    // Only the teacher's own approval makes it official.
    if (proposed.status !== "pending-approval") return;
    const official = await assessment.approveGradeProposal(P.patel, proposed.proposal.id);
    expect(official).toMatchObject({ version: 1, approval: { approvedBy: "prn_nf-teacher-patel", channel: "http" }, proposal: { proposedVia: "mcp-tool" } });
  });

  it("is posted only by someone who may give feedback, and only from a finished run", async () => {
    const env = await threeSubjects();
    const submissionId = env.essay.receipt.submissionId;
    const own = await env.ci.run(P.amara, { submissionId, idempotencyKey: "student-check" });
    // The student can run CI, but not turn it into feedback on their own work.
    await rejectsWith(env.ci.suggestScores(P.amara, submissionId, own.runId), "forbidden");

    const queued = await env.runs.request({
      submissionDigest: (await env.assessment.getSubmission(P.rivera, submissionId)).submissionDigest,
      rubricRelease: { rubricId: env.essay.release.rubricId, version: 1 },
      executionProfile: "deterministic@1",
      idempotencyKey: "not-yet-run",
    });
    await rejectsWith(env.ci.suggestScores(P.rivera, submissionId, queued.id), "conflict");
  });
});
