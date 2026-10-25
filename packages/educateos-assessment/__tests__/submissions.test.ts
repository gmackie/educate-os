import { describe, expect, it } from "vitest";
import { canonicalTextBytes, sha256Digest } from "@educateos/learning-artifacts";
import { submissionDigest, submissionDigestBytes } from "../src/index.ts";
import { DUE, O, P, doc, ref, rejectsWith, text, withEssay } from "./setup.ts";

describe("E01 acceptance: content digests are pinned and post-submission work is preserved independently", () => {
  it("leaves the snapshot's digest and readable content unchanged when the essay is edited after submitting", async () => {
    const { assessment, artifacts, artifactRecords, assignment, essay } = await withEssay(P.amara, "Draft one: membranes are selectively permeable.");

    const receipt = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    const submitted = await assessment.getSubmission(P.amara, receipt.submissionId);
    expect(submitted.items).toEqual([expect.objectContaining({ artifactId: essay.artifact.id, revisionId: essay.head.id, digest: essay.head.content.digest })]);
    expect(submitted.items[0]!.digest).toBe(await sha256Digest(canonicalTextBytes("Draft one: membranes are selectively permeable.")));

    // The revision is pinned for this submission in the learning artifact store.
    const { state } = await artifactRecords.load();
    expect(state.pins).toContainEqual(expect.objectContaining({
      artifactId: essay.artifact.id,
      revisionId: essay.head.id,
      consumer: { kind: "submission", submissionId: receipt.submissionId },
    }));

    // Amara keeps working on the essay.
    const edited = await artifacts.saveRevision(P.amara, essay.artifact.id, text("Draft two, rewritten after submitting."));
    expect(edited.head.content.digest).not.toBe(essay.head.content.digest);
    expect((await artifacts.readRevision(P.amara, essay.artifact.id)).content).toEqual({ kind: "text", text: "Draft two, rewritten after submitting." });

    const after = await assessment.getSubmission(P.amara, receipt.submissionId);
    expect(after).toEqual(submitted);
    expect(after.submissionDigest).toBe(receipt.submissionDigest);
    for (const reader of [P.amara, P.morgan]) {
      expect((await assessment.readSubmittedContent(reader, receipt.submissionId, essay.artifact.id)).content)
        .toEqual({ kind: "text", text: "Draft one: membranes are selectively permeable." });
    }
  });

  it("returns a receipt whose digest anyone holding the revisions can recompute", async () => {
    const { assessment, artifacts, workspace, assignment, essay } = await withEssay();
    const data = await artifacts.createArtifact(P.amara, {
      workspaceId: workspace.id,
      type: "dataset",
      title: "Osmosis lab data",
      content: { kind: "text", mediaType: "text/csv", text: "minute,mass_g\n0,5.0\n10,5.4\n" },
      aiAssistance: { level: "assisted", modelId: "workers-ai/llama-3.3-70b" },
    });

    // The digest is over the canonical (sorted) list, whatever order the revisions were given in.
    const forward = await assessment.submit(P.amara, assignment.id, [ref(essay), ref(data)]);
    expect(forward).toMatchObject({ format: "educateos.submission-receipt.v1", attempt: 1, timing: "on-time", studentPrincipalId: P.amara.principal.principalId });
    const recomputed = await submissionDigest([
      { artifactId: data.artifact.id, revisionId: data.head.id, digest: data.head.content.digest },
      { artifactId: essay.artifact.id, revisionId: essay.head.id, digest: essay.head.content.digest },
    ]);
    expect(forward.submissionDigest).toBe(recomputed);
    expect(forward.submissionDigest).toBe(await sha256Digest(submissionDigestBytes(forward.items)));

    // AI-assistance metadata is carried from each revision.
    const snapshot = await assessment.getSubmission(P.amara, forward.submissionId);
    expect(snapshot.items.find((i) => i.artifactId === data.artifact.id)?.aiAssistance).toEqual({ level: "assisted", modelId: "workers-ai/llama-3.3-70b" });
    expect(snapshot.items.find((i) => i.artifactId === essay.artifact.id)?.aiAssistance).toEqual({ level: "none" });
    expect(snapshot.rubric).toEqual(assignment.rubric);
  });
});

describe("submitting", () => {
  it("is idempotent: the same revisions again return the same receipt and use no attempt", async () => {
    const { assessment, assignment, essay } = await withEssay();
    const first = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    const again = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    expect(again).toEqual(first);
    expect(await assessment.listSubmissions(P.amara, assignment.id)).toHaveLength(1);
  });

  it("refuses an attempt past the assignment's limit", async () => {
    const { assessment, artifacts, assignment, essay } = await withEssay(P.amara, "v1", { attemptsAllowed: 2 });
    const first = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    const v2 = await artifacts.saveRevision(P.amara, essay.artifact.id, text("v2"));
    const second = await assessment.submit(P.amara, assignment.id, [ref(v2)]);
    expect([first.attempt, second.attempt]).toEqual([1, 2]);
    expect(second.submissionId).not.toBe(first.submissionId);

    const v3 = await artifacts.saveRevision(P.amara, essay.artifact.id, text("v3"));
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(v3)]), "forbidden");
    // A retry of the latest attempt is still answered.
    expect(await assessment.submit(P.amara, assignment.id, [ref(v2)])).toEqual(second);
  });

  it("flags work after the due date as late under an accepting policy, and refuses it once the window closes", async () => {
    const { assessment, artifacts, assignment, essay, clock } = await withEssay(P.amara, "v1", {
      attemptsAllowed: 3,
      latePolicy: { kind: "accept", closesAt: "2026-10-28T23:59:00Z" },
    });
    clock.now = new Date(DUE);
    expect((await assessment.submit(P.amara, assignment.id, [ref(essay)])).timing).toBe("on-time");

    clock.now = new Date("2026-10-26T08:00:00Z");
    const v2 = await artifacts.saveRevision(P.amara, essay.artifact.id, text("v2"));
    const late = await assessment.submit(P.amara, assignment.id, [ref(v2)]);
    expect(late.timing).toBe("late");
    expect((await assessment.getSubmission(P.morgan, late.submissionId)).timing).toBe("late");

    clock.now = new Date("2026-10-29T00:00:00Z");
    const v3 = await artifacts.saveRevision(P.amara, essay.artifact.id, text("v3"));
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(v3)]), "forbidden");
  });

  it("refuses late work under a refusing policy", async () => {
    const { assessment, assignment, essay, clock } = await withEssay(P.amara, "v1", { latePolicy: { kind: "refuse" } });
    clock.now = new Date("2026-10-26T00:00:00Z");
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(essay)]), "forbidden");
  });

  it("only takes the student's own course work in the assignment's offering, of a permitted type", async () => {
    const { assessment, artifacts, workspaces, assignment, essay } = await withEssay();
    // Elena cannot submit Amara's essay: she cannot even see it.
    await rejectsWith(assessment.submit(P.elena, assignment.id, [ref(essay)]), "not-found");
    // Personal-workspace work is not course work.
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const diary = await artifacts.createArtifact(P.amara, doc(personal.id, "private notes"));
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(diary)]), "not-found");
    // Work from another of Amara's offerings.
    const eng = await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
    const engEssay = await artifacts.createArtifact(P.amara, doc(eng.id, "Poetry analysis"));
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(engEssay)]), "not-found");
    // A type the assignment does not accept.
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const slides = await artifacts.createArtifact(P.amara, { ...doc(bio.id, "slides"), type: "presentation" });
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(slides)]), "validation-failed");
    // The same artifact twice.
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(essay), ref(essay)]), "validation-failed");
  });

  it("is refused to a student who has been dropped from the offering", async () => {
    const { assessment, assignment, essay, changeDirectory } = await withEssay();
    await changeDirectory((draft) => {
      draft.enrollments.find((e) => e.id === "enr_nf-02")!.status = "inactive";
    });
    await rejectsWith(assessment.submit(P.amara, assignment.id, [ref(essay)]), "not-found");
  });
});

describe("withdrawing", () => {
  it("marks a submission withdrawn before the deadline and deletes nothing", async () => {
    const { assessment, artifacts, artifactRecords, assignment, essay } = await withEssay(P.amara, "v1", { attemptsAllowed: 1 });
    const receipt = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    const before = await assessment.getSubmission(P.amara, receipt.submissionId);

    const withdrawn = await assessment.withdraw(P.amara, receipt.submissionId);
    expect(withdrawn).toEqual({ ...before, withdrawnAt: expect.any(String) });
    expect(await assessment.withdraw(P.amara, receipt.submissionId)).toEqual(withdrawn);

    // Still stored, listed, pinned and readable.
    expect(await assessment.listSubmissions(P.morgan, assignment.id)).toEqual([withdrawn]);
    const { state } = await artifactRecords.load();
    expect(state.pins.filter((p) => p.consumer.kind === "submission" && p.consumer.submissionId === receipt.submissionId)).toHaveLength(1);
    expect((await assessment.readSubmittedContent(P.amara, receipt.submissionId, essay.artifact.id)).content).toEqual({ kind: "text", text: "v1" });

    // It no longer counts against the limit, and the next attempt gets a new number.
    const v2 = await artifacts.saveRevision(P.amara, essay.artifact.id, text("v2"));
    expect((await assessment.submit(P.amara, assignment.id, [ref(v2)])).attempt).toBe(2);
  });

  it("is refused after the due date, and to anyone but the student", async () => {
    const { assessment, assignment, essay, clock } = await withEssay();
    const receipt = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    await rejectsWith(assessment.withdraw(P.morgan, receipt.submissionId), "forbidden");
    await rejectsWith(assessment.withdraw(P.elena, receipt.submissionId), "not-found");
    clock.now = new Date("2026-10-26T00:00:00Z");
    await rejectsWith(assessment.withdraw(P.amara, receipt.submissionId), "forbidden");
  });
});

describe("who sees a submission", () => {
  it("is its student and the offering's teachers: never another student or an administrator", async () => {
    const { assessment, assignment, essay } = await withEssay();
    const receipt = await assessment.submit(P.amara, assignment.id, [ref(essay)]);

    expect((await assessment.getSubmission(P.morgan, receipt.submissionId)).id).toBe(receipt.submissionId);
    expect(await assessment.listSubmissions(P.morgan, assignment.id)).toHaveLength(1);

    for (const outsider of [P.elena, P.dmitri, P.nfAdmin, P.rivera]) {
      await rejectsWith(assessment.getSubmission(outsider, receipt.submissionId), "not-found");
      await rejectsWith(assessment.readSubmittedContent(outsider, receipt.submissionId, essay.artifact.id), "not-found");
    }
    // Elena sees the assignment, but not Amara's submission in it.
    expect(await assessment.listSubmissions(P.elena, assignment.id)).toEqual([]);
    // The administrator sees the assignment's structure only.
    expect(await assessment.listSubmissions(P.nfAdmin, assignment.id)).toEqual([]);
  });
});
