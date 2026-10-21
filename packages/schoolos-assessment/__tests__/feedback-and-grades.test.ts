import { RevisionId } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import { O, P, doc, essayAssignment, ref, rejectsWith, setup, withEssay } from "./setup.ts";

const AI = { kind: "ai", modelId: "workers-ai/llama-3.3-70b" } as const;
const SCORE = { points: 17, maxPoints: 20 };

async function submitted(overrides: Parameters<typeof withEssay>[2] = {}) {
  const env = await withEssay(P.amara, "Membranes are selectively permeable because of the lipid bilayer.", overrides);
  const receipt = await env.assessment.submit(P.amara, env.assignment.id, [ref(env.essay)]);
  return { ...env, receipt, submissionId: receipt.submissionId };
}

describe("feedback", () => {
  it("anchors comments to a submitted revision and a range in it", async () => {
    const { assessment, essay, submissionId } = await submitted();
    const comment = await assessment.addComment(P.morgan, submissionId, {
      anchor: { artifactId: essay.artifact.id, revisionId: essay.head.id, region: { kind: "text-range", start: 0, end: 9 } },
      body: "Define 'selectively permeable'.",
    });
    expect(comment).toMatchObject({ source: { kind: "teacher" }, enteredBy: P.morgan.principal.principalId });

    // An anchor must point into what was submitted.
    await rejectsWith(assessment.addComment(P.morgan, submissionId, {
      anchor: { artifactId: essay.artifact.id, revisionId: RevisionId.parse("rev_not-submitted"), region: { kind: "text-range", start: 0, end: 4 } },
      body: "x",
    }), "validation-failed");
    await rejectsWith(assessment.addComment(P.morgan, submissionId, {
      anchor: { artifactId: essay.artifact.id, revisionId: essay.head.id, region: { kind: "text-range", start: 0, end: 10_000 } },
      body: "x",
    }), "validation-failed");
  });

  it("labels every score or comment from an agent, tool or evaluator as suggested", async () => {
    const { assessment, submissionId } = await submitted();
    // An agent cannot enter a score as the teacher's own judgement.
    await rejectsWith(assessment.scoreCriterion(P.morganAgent, submissionId, { criterionId: "thesis", points: 4, maxPoints: 5 }), "validation-failed");
    const suggestion = await assessment.scoreCriterion(P.morganAgent, submissionId, { criterionId: "thesis", points: 4, maxPoints: 5, suggestedBy: AI });
    expect(suggestion.source).toEqual({ kind: "suggested", suggester: AI });
    const teacher = await assessment.scoreCriterion(P.morgan, submissionId, { criterionId: "thesis", points: 3, maxPoints: 5 });
    expect(teacher.source).toEqual({ kind: "teacher" });
    // Both are kept, each labelled.
    expect((await assessment.getFeedback(P.morgan, submissionId)).scores.map((s) => s.source.kind).toSorted()).toEqual(["suggested", "teacher"]);
  });

  it("reaches the student only once shared, and never with a suggestion", async () => {
    const { assessment, submissionId } = await submitted();
    await assessment.addComment(P.morganAgent, submissionId, { body: "AI: consider citing your lab data.", suggestedBy: AI });
    await assessment.addComment(P.morgan, submissionId, { body: "Strong opening." });
    await assessment.scoreCriterion(P.morganAgent, submissionId, { criterionId: "evidence", points: 2, maxPoints: 5, suggestedBy: AI });

    await rejectsWith(assessment.getFeedback(P.amara, submissionId), "not-found");
    expect((await assessment.advanceFeedback(P.morgan, submissionId, "shared-with-student")).state).toBe("shared-with-student");

    const seen = await assessment.getFeedback(P.amara, submissionId);
    expect(seen.comments.map((c) => c.body)).toEqual(["Strong opening."]);
    expect(seen.scores).toEqual([]);
    // Other students and administrators see nothing.
    await rejectsWith(assessment.getFeedback(P.elena, submissionId), "not-found");
    await rejectsWith(assessment.getFeedback(P.nfAdmin, submissionId), "not-found");
  });

  it("moves draft, shared-with-student, final, and never back; a final result is frozen", async () => {
    const { assessment, submissionId } = await submitted({ feedbackVisibility: "when-final" });
    await assessment.addComment(P.morgan, submissionId, { body: "Good." });
    // Agents cannot release feedback to a student, and students cannot release their own.
    await rejectsWith(assessment.advanceFeedback(P.morganAgent, submissionId, "shared-with-student"), "forbidden");
    await rejectsWith(assessment.advanceFeedback(P.amara, submissionId, "final"), "forbidden");

    await assessment.advanceFeedback(P.morgan, submissionId, "shared-with-student");
    // Under `when-final`, sharing alone is not enough.
    await rejectsWith(assessment.getFeedback(P.amara, submissionId), "not-found");
    await assessment.advanceFeedback(P.morgan, submissionId, "final");
    expect((await assessment.getFeedback(P.amara, submissionId)).state).toBe("final");

    await rejectsWith(assessment.advanceFeedback(P.morgan, submissionId, "shared-with-student"), "conflict");
    await rejectsWith(assessment.addComment(P.morgan, submissionId, { body: "One more thing." }), "conflict");
  });

  it("is written only by the offering's teachers", async () => {
    const { assessment, submissionId } = await submitted();
    await rejectsWith(assessment.addComment(P.amara, submissionId, { body: "I deserve full marks." }), "forbidden");
    await rejectsWith(assessment.scoreCriterion(P.amara, submissionId, { criterionId: "thesis", points: 5 }), "forbidden");
    await rejectsWith(assessment.addComment(P.elena, submissionId, { body: "nice" }), "not-found");
  });
});

describe("the official grade gate", () => {
  it("never makes an AI-suggested score official without a teacher's explicit approval", async () => {
    const { assessment, assignment, submissionId, receipt } = await submitted();
    await assessment.scoreCriterion(P.morganAgent, submissionId, { criterionId: "thesis", points: 5, maxPoints: 5, suggestedBy: AI });
    // A suggestion alone is not a grade.
    expect(await assessment.officialGrades(P.morgan, assignment.id, P.amara.principal.principalId)).toEqual([]);

    // The teacher's agent proposes the grade; policy sends it for review.
    const outcome = await assessment.recordOfficialGrade(P.morganAgent, { submissionId, score: SCORE });
    if (outcome.status !== "pending-approval") throw new Error(`expected a proposal, got ${outcome.status}`);
    expect(outcome.proposal).toMatchObject({ proposedVia: "agent", proposedBy: P.morgan.principal.principalId });
    expect(await assessment.officialGrades(P.morgan, assignment.id, P.amara.principal.principalId)).toEqual([]);
    expect(await assessment.officialGrades(P.amara, assignment.id, P.amara.principal.principalId)).toEqual([]);
    expect(await assessment.pendingGradeProposals(P.morgan, assignment.id)).toEqual([outcome.proposal]);
    expect(await assessment.pendingGradeProposals(P.amara, assignment.id)).toEqual([]);

    // Neither the agent nor the student can approve it.
    await rejectsWith(assessment.approveGradeProposal(P.morganAgent, outcome.proposal.id), "forbidden");
    await rejectsWith(assessment.approveGradeProposal(P.amara, outcome.proposal.id), "forbidden");

    const official = await assessment.approveGradeProposal(P.morgan, outcome.proposal.id);
    expect(official).toEqual({
      format: "schoolos.official-grade.v1",
      districtId: "dst_northfield",
      offeringId: assignment.offeringId,
      assignmentId: assignment.id,
      studentPrincipalId: P.amara.principal.principalId,
      submissionId,
      submissionDigest: receipt.submissionDigest,
      version: 1,
      score: SCORE,
      approval: { approvedBy: P.morgan.principal.principalId, approvedAt: expect.any(String), channel: "http" },
      proposal: { proposalId: outcome.proposal.id, proposedBy: P.morgan.principal.principalId, proposedVia: "agent", proposedAt: outcome.proposal.proposedAt },
    });
    // Approval is idempotent, and the student now sees their grade.
    expect(await assessment.approveGradeProposal(P.morgan, outcome.proposal.id)).toEqual(official);
    expect(await assessment.officialGrades(P.amara, assignment.id, P.amara.principal.principalId)).toEqual([official]);
    expect(await assessment.pendingGradeProposals(P.morgan, assignment.id)).toEqual([]);
  });

  it("lets a teacher acting directly record a grade, with monotonically increasing versions", async () => {
    const { assessment, assignment, submissionId, records } = await submitted();
    const first = await assessment.recordOfficialGrade(P.morgan, { submissionId, score: SCORE });
    const second = await assessment.recordOfficialGrade(P.morgan, { submissionId, score: { points: 18, maxPoints: 20 } });
    if (first.status !== "official" || second.status !== "official") throw new Error("expected official grades");
    expect([first.version.version, second.version.version]).toEqual([1, 2]);
    expect(first.version.approval.approvedBy).toBe(P.morgan.principal.principalId);
    expect(first.version.proposal).toBeUndefined();
    expect((await assessment.officialGrades(P.morgan, assignment.id, P.amara.principal.principalId)).map((v) => v.score.points)).toEqual([17, 18]);

    // The store refuses a rewritten or skipped version, whatever writes to it.
    const { state, version } = await records.load();
    await rejectsWith(records.commit({ ...state, gradeVersions: state.gradeVersions.map((v) => ({ ...v, score: { points: 20, maxPoints: 20 } })) }, version), "policy-violation");
    await rejectsWith(records.commit({ ...state, gradeVersions: [...state.gradeVersions, { ...state.gradeVersions[1]!, version: 4 }] }, version), "policy-violation");
    await rejectsWith(records.commit({ ...state, gradeVersions: state.gradeVersions.slice(0, 1) }, version), "policy-violation");
  });

  it("sends a co-teacher's grade for a teacher's approval and refuses one from a student", async () => {
    const { assessment, artifacts, workspaces } = setup();
    // English 9: Rivera teaches, Chen co-teaches.
    const assignment = await assessment.createAssignment(P.rivera, essayAssignment({ offeringId: O.eng9 }));
    const workspace = await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
    const essay = await artifacts.createArtifact(P.amara, doc(workspace.id, "Stanza one turns on the image of the tide.", "Poetry analysis"));
    const { submissionId } = await assessment.submit(P.amara, assignment.id, [ref(essay)]);

    const outcome = await assessment.recordOfficialGrade(P.chen, { submissionId, score: SCORE });
    if (outcome.status !== "pending-approval") throw new Error(`expected a proposal, got ${outcome.status}`);
    await rejectsWith(assessment.approveGradeProposal(P.chen, outcome.proposal.id), "forbidden");
    expect((await assessment.approveGradeProposal(P.rivera, outcome.proposal.id)).approval.approvedBy).toBe(P.rivera.principal.principalId);

    await rejectsWith(assessment.recordOfficialGrade(P.amara, { submissionId, score: { points: 20, maxPoints: 20 } }), "forbidden");
    await rejectsWith(assessment.recordOfficialGrade(P.elena, { submissionId, score: SCORE }), "not-found");
  });

  it("keeps a student's grades from their classmates", async () => {
    const { assessment, assignment, submissionId } = await submitted();
    await assessment.recordOfficialGrade(P.morgan, { submissionId, score: SCORE });
    await rejectsWith(assessment.officialGrades(P.elena, assignment.id, P.amara.principal.principalId), "not-found");
  });

  it("stays readable to a student after they leave the offering, with their submission", async () => {
    const { assessment, assignment, submissionId, changeDirectory } = await submitted();
    const result = await assessment.recordOfficialGrade(P.morgan, { submissionId, score: SCORE });
    await changeDirectory((draft) => {
      draft.enrollments.find((e) => e.id === "enr_nf-02")!.status = "inactive"; // Amara leaves Biology
    });
    await rejectsWith(assessment.getAssignment(P.amara, assignment.id), "not-found");
    expect(await assessment.officialGrades(P.amara, assignment.id, P.amara.principal.principalId)).toEqual([result.status === "official" ? result.version : undefined]);
    expect((await assessment.getSubmission(P.amara, submissionId)).id).toBe(submissionId);
  });
});
