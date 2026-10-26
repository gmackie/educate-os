// SCHO-232: rubric releases signed, runs requested and reports stored before the EducateOS rename
// carry `schoolos.*` format names, in their own fields and in what their digests and IDs were (rename-educateos: keep)
// derived from. They still verify, are found again, and parse, while new ones use the new names.
import { describe, expect, it } from "vitest";
import { ArtifactId, ContentDigest, RevisionId } from "@educateos/contracts";
import { submissionDigest, type SubmissionItem } from "@educateos/assessment";
import { canonicalTextBytes, sha256Digest } from "@educateos/learning-artifacts";
import {
  AssessmentReport,
  AssessmentRuns,
  DETERMINISTIC_PROFILE,
  InMemoryAssessmentRunStore,
  InMemoryRubricReleaseStore,
  StudentAssessmentReport,
  assessmentRunIdFor,
  builtinRegistry,
  canonicalDigest,
  legacyAssessmentRunIdFor,
  rubricRef,
  signRubricRelease,
  verifyRubricRelease,
  type AssessmentRun,
  type RubricRelease,
  type SubmittedWork,
} from "../src/index.ts";
import { ESSAY, NOW, P, essayRubric } from "./setup.ts";

/** `release` as the code before the rename signed it: the legacy format, in the record and its digest. */
async function asLegacy(release: RubricRelease): Promise<RubricRelease> {
  const { signature, format: _format, ...body } = release;
  const digest = await canonicalDigest({ format: "schoolos.rubric-release.v1", ...body }); // rename-educateos: keep
  return { format: "schoolos.rubric-release.v1", ...body, signature: { ...signature, digest } }; // rename-educateos: keep
}

async function essayWork() {
  const bytes = canonicalTextBytes(ESSAY);
  const items: SubmissionItem[] = [{
    artifactId: ArtifactId.parse("art_essay"),
    revisionId: RevisionId.parse("rev_essay"),
    digest: await sha256Digest(bytes),
    artifactType: "document",
    mediaType: "text/markdown",
    sizeBytes: bytes.byteLength,
    aiAssistance: { level: "none" },
  }];
  const work: SubmittedWork = { items, readText: async () => ESSAY };
  const canonical = items.map(({ artifactId, revisionId, digest }) => ({ artifactId, revisionId, digest }));
  const legacyDigest = await sha256Digest(new TextEncoder().encode(JSON.stringify({ format: "schoolos.submission-digest.v1", items: canonical }))); // rename-educateos: keep
  return { work, legacyDigest: ContentDigest.parse(legacyDigest) };
}

describe("records from before the EducateOS rename", () => {
  it("verify a rubric release signed under the legacy format, exactly as stored", async () => {
    const release = await signRubricRelease(essayRubric(), P.rivera, builtinRegistry(), NOW);
    expect(release.format).toBe("educateos.rubric-release.v1");
    const legacy = await asLegacy(release);
    expect(legacy.signature.digest).not.toBe(release.signature.digest);
    await verifyRubricRelease(JSON.parse(JSON.stringify(legacy)));
    const store = new InMemoryRubricReleaseStore();
    await store.put(legacy);
    expect(await store.get(legacy)).toEqual(legacy);
    // The legacy spelling is not a way around the signature.
    await expect(verifyRubricRelease({ ...legacy, title: "Changed" })).rejects.toMatchObject({ code: "policy-violation" });
    await expect(verifyRubricRelease({ ...legacy, signature: release.signature })).rejects.toMatchObject({ code: "policy-violation" });
  });

  it("find a run requested before the rename instead of requesting it again, and execute it", async () => {
    const registry = builtinRegistry();
    const rubrics = new InMemoryRubricReleaseStore();
    await rubrics.put(await asLegacy(await signRubricRelease(essayRubric(), P.rivera, registry, NOW)));
    const { work, legacyDigest } = await essayWork();
    const request = { submissionDigest: legacyDigest, rubricRelease: rubricRef(essayRubric()), executionProfile: DETERMINISTIC_PROFILE.id, idempotencyKey: "submitted" };

    // What the new code would queue for the request, and the run the old code queued for it.
    const scratch = await new AssessmentRuns({ runs: new InMemoryAssessmentRunStore(), rubrics, registry, now: () => NOW }).request(request);
    const legacyEvaluators = await canonicalDigest({ format: "schoolos.evaluator-set.v1", releases: scratch.evaluators }); // rename-educateos: keep
    const legacyKey = { ...scratch.key, evaluatorRelease: legacyEvaluators };
    const legacyId = await legacyAssessmentRunIdFor(scratch.key, legacyEvaluators);
    expect(legacyId).toBe(`asr_${(await canonicalDigest({ format: "schoolos.assessment-run-key.v1", key: legacyKey })).slice(7, 47)}`); // rename-educateos: keep
    expect(legacyId).not.toBe(scratch.id);
    expect(scratch.id).toBe(await assessmentRunIdFor(scratch.key));
    const stored: AssessmentRun = { ...scratch, id: legacyId, key: legacyKey };

    const store = new InMemoryAssessmentRunStore();
    await store.insert(stored);
    const runs = new AssessmentRuns({ runs: store, rubrics, registry, now: () => NOW });
    const found = await runs.request(request);
    expect(found.id).toBe(legacyId);
    expect(await store.get(scratch.id)).toBeUndefined();

    // Its work was digested under the legacy name; it still executes, and the report is new.
    const done = await runs.execute(legacyId, work);
    expect(done.state).toBe("completed");
    expect(done.report?.format).toBe("educateos.assessment-report.v2");
  });

  it("refuse work that is not the submission under either digest", async () => {
    const registry = builtinRegistry();
    const rubrics = new InMemoryRubricReleaseStore();
    await rubrics.put(await signRubricRelease(essayRubric(), P.rivera, registry, NOW));
    const { work } = await essayWork();
    const runs = new AssessmentRuns({ runs: new InMemoryAssessmentRunStore(), rubrics, registry, now: () => NOW });
    const other = await submissionDigest([{ ...work.items[0]!, revisionId: RevisionId.parse("rev_other") }]);
    const run = await runs.request({ submissionDigest: other, rubricRelease: rubricRef(essayRubric()), executionProfile: DETERMINISTIC_PROFILE.id, idempotencyKey: "x" });
    expect((await runs.execute(run.id, work)).error?.code).toBe("integrity");
  });

  it("parse stored reports with the legacy formats", async () => {
    const registry = builtinRegistry();
    const rubrics = new InMemoryRubricReleaseStore();
    await rubrics.put(await signRubricRelease(essayRubric(), P.rivera, registry, NOW));
    const { work } = await essayWork();
    const runs = new AssessmentRuns({ runs: new InMemoryAssessmentRunStore(), rubrics, registry, now: () => NOW });
    const digest = await submissionDigest(work.items);
    const run = await runs.request({ submissionDigest: digest, rubricRelease: rubricRef(essayRubric()), executionProfile: DETERMINISTIC_PROFILE.id, idempotencyKey: "k" });
    const report = (await runs.execute(run.id, work)).report!;
    const legacy = { ...report, format: "schoolos.assessment-report.v2" }; // rename-educateos: keep
    expect(AssessmentReport.parse(legacy)).toEqual(legacy);
    const student = StudentAssessmentReport.parse({ format: "schoolos.assessment-report.student.v1", runId: run.id, rubric: rubricRef(essayRubric()), criteria: [], summary: report.summary }); // rename-educateos: keep
    expect(student.format).toBe("schoolos.assessment-report.student.v1"); // rename-educateos: keep
    expect(AssessmentReport.safeParse({ ...report, format: "other.assessment-report.v2" }).success).toBe(false);
  });
});
