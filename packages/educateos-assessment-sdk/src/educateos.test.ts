import { describe, expect, it } from "vitest";
import { DistrictId, type Caller } from "@educateos/contracts";
import { createEducateOsReader } from "./educateos.ts";
import { ESSAY, O, P, essayRubric, setup, threeSubjects } from "../../educateos-assessment-ci/__tests__/setup.ts";

async function essayFixture() {
  const env = setup();
  const essay = await env.submitWork({
    teacher: P.rivera,
    student: P.amara,
    offeringId: O.eng9,
    rubric: essayRubric(),
    work: [{ type: "document", mediaType: "text/markdown", title: "Synthetic essay", text: ESSAY }],
  });
  return { ...env, essay };
}

describe("EducateOS read adapter with actual district services", () => {
  it("returns the submitted snapshot and digest-verified revision without translating artifact references", async () => {
    const env = await essayFixture();
    const reader = createEducateOsReader({ ...env, caller: () => P.rivera });
    const request = { submissionId: env.essay.receipt.submissionId };
    const submission = await reader.submission(request);
    const item = submission.items[0]!;
    const evidence = await reader.evidence({ ...request, artifactId: item.artifactId });
    expect(evidence.item).toEqual(item);
    expect(evidence.content).toMatchObject({ kind: "text", text: ESSAY });
    expect(submission.submissionDigest).toBe(env.essay.receipt.submissionDigest);
    expect(Object.keys(reader).toSorted()).toEqual(["evidence", "feedback", "report", "submission"]);
  });

  it("rejects self-asserted authority and unknown request fields at the adapter boundary", async () => {
    const env = await essayFixture();
    const reader = createEducateOsReader({ ...env, caller: () => P.amara });
    const request = { submissionId: env.essay.receipt.submissionId };
    for (const injected of [{ role: "teacher" }, { caller: P.rivera }, { districtId: "dst_other" }, { channel: "http" }]) {
      await expect(reader.submission({ ...request, ...injected })).rejects.toThrow();
    }
    await expect(reader.evidence({ ...request, artifactId: "not-an-artifact" })).rejects.toThrow();
    await expect(reader.report({ ...request, runId: "not-a-run" })).rejects.toThrow();
    await expect(reader.feedback({ ...request, includeSuggestions: true })).rejects.toThrow();
  });

  it("resolves the current session on every read and denies peers, unrelated teachers and other districts", async () => {
    const env = await essayFixture();
    let authenticated: Caller = P.rivera;
    const reader = createEducateOsReader({ ...env, caller: () => authenticated });
    const request = { submissionId: env.essay.receipt.submissionId };
    const submission = await reader.submission(request);
    const run = await env.ci.run(P.rivera, { ...request, idempotencyKey: "bridge-isolation" });
    for (const outsider of [
      P.elena,
      P.patel,
      { ...P.rivera, principal: { ...P.rivera.principal, districtId: DistrictId.parse("dst_other") } },
    ]) {
      authenticated = outsider;
      await expect(reader.submission(request)).rejects.toMatchObject({ code: "not-found" });
      await expect(reader.evidence({ ...request, artifactId: submission.items[0]!.artifactId })).rejects.toMatchObject({ code: "not-found" });
      await expect(reader.report({ ...request, runId: run.runId })).rejects.toMatchObject({ code: "not-found" });
      await expect(reader.feedback(request)).rejects.toMatchObject({ code: "not-found" });
    }
  });

  it("retains teacher findings while keeping answer-keyed checks and suggestions out of the student view", async () => {
    const env = await threeSubjects();
    let authenticated: Caller = P.patel;
    const reader = createEducateOsReader({ ...env, caller: () => authenticated });
    const request = { submissionId: env.math.receipt.submissionId };
    const run = await env.ci.run(P.patel, { ...request, idempotencyKey: "bridge-hidden-answers" });
    const teacher = await reader.report({ ...request, runId: run.runId });
    expect(teacher.view).toBe("teacher");
    expect(JSON.stringify(teacher)).toContain("math.answers");
    await env.ci.suggestScores(P.patel, request.submissionId, run.runId);
    await env.assessment.advanceFeedback(P.patel, request.submissionId, "shared-with-student");
    authenticated = P.chidi;
    const student = await reader.report({ ...request, runId: run.runId });
    expect(student.view).toBe("student");
    for (const hidden of ["math.answers", "17/4", "4.25", "suggestions"]) {
      expect(JSON.stringify(student)).not.toContain(hidden);
    }
    expect((await reader.feedback(request)).scores).toEqual([]);
    expect(await env.assessment.officialGrades(P.patel, env.math.receipt.assignmentId, P.chidi.principal.principalId)).toEqual([]);
  });

  it("cannot retrieve a report through an unrelated submission the caller may read", async () => {
    const env = await threeSubjects();
    const run = await env.ci.run(P.rivera, { submissionId: env.essay.receipt.submissionId, idempotencyKey: "essay" });
    const reader = createEducateOsReader({ ...env, caller: () => P.patel });
    await expect(reader.report({ submissionId: env.math.receipt.submissionId, runId: run.runId })).rejects.toMatchObject({ code: "not-found" });
  });
});
