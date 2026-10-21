// `DurableObjectAssessmentRecordStore` in workerd, against real Durable Object SQLite storage: the
// records survive a restart, exactly one of several commits from the same version wins, the record
// invariants hold at the storage layer, and a refused commit leaves nothing behind.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AssessmentState, AssignmentBinding, SubmissionSnapshot } from "../../src/index.ts";
import { ASSESSMENT_RECORDS_TABLE, AssessmentRecordCorruptionError, DurableObjectAssessmentRecordStore } from "../../src/durable-object-store.ts";

let objects = 0;
const fresh = () => env.RECORDS.getByName(`district-${objects++}`);

const EMPTY: AssessmentState = { assignments: [], starterMaterials: [], submissions: [], feedback: [], gradeProposals: [], gradeVersions: [] };

function assignment(title: string): AssignmentBinding {
  return {
    id: "asg_bio-essay" as AssignmentBinding["id"],
    districtId: "dst_northfield" as AssignmentBinding["districtId"],
    offeringId: "off_nf-bio-fall-p2" as AssignmentBinding["offeringId"],
    activityId: "act_cell-membrane-essay" as AssignmentBinding["activityId"],
    title,
    dueAt: "2026-10-25T23:59:00.000Z",
    latePolicy: { kind: "accept" },
    attemptsAllowed: 2,
    permittedArtifactTypes: ["document"],
    feedbackVisibility: "when-shared",
    createdBy: "prn_nf-morgan-lee" as AssignmentBinding["createdBy"],
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
}

const submission: SubmissionSnapshot = {
  id: "sub_amara-1" as SubmissionSnapshot["id"],
  districtId: "dst_northfield" as SubmissionSnapshot["districtId"],
  assignmentId: "asg_bio-essay" as SubmissionSnapshot["assignmentId"],
  offeringId: "off_nf-bio-fall-p2" as SubmissionSnapshot["offeringId"],
  studentPrincipalId: "prn_nf-student-amara" as SubmissionSnapshot["studentPrincipalId"],
  attempt: 1,
  items: [{
    artifactId: "art_essay" as SubmissionSnapshot["items"][number]["artifactId"],
    revisionId: "rev_essay-1" as SubmissionSnapshot["items"][number]["revisionId"],
    digest: `sha256:${"a".repeat(64)}` as SubmissionSnapshot["submissionDigest"],
    artifactType: "document",
    mediaType: "text/markdown",
    sizeBytes: 12,
    aiAssistance: { level: "none" },
  }],
  submissionDigest: `sha256:${"b".repeat(64)}` as SubmissionSnapshot["submissionDigest"],
  submittedAt: "2026-10-20T12:30:00.000Z",
  timing: "on-time",
  channel: "http",
};

describe("DurableObjectAssessmentRecordStore", () => {
  it("starts empty and keeps committed records across a restart", async () => {
    const records = fresh();
    expect(await records.load()).toEqual({ version: 0, state: EMPTY });
    expect(await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")] }, 0)).toEqual({ ok: true });
    expect(await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")], submissions: [submission] }, 1)).toEqual({ ok: true });

    await evictDurableObject(records);
    const stored = await records.load();
    expect(stored.version).toBe(2);
    expect(stored.state.submissions).toEqual([submission]);
  });

  it("lets exactly one of ten concurrent commits from the same version win", async () => {
    const records = fresh();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => records.commit({ ...EMPTY, assignments: [assignment(`Essay ${i}`)] }, 0)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "conflict")).toHaveLength(9);
    const winner = results.findIndex((r) => r.ok);
    expect(await records.load()).toMatchObject({ version: 1, state: { assignments: [{ title: `Essay ${winner}` }] } });
  });

  it("refuses a commit that rewrites the record, and stores nothing of it", async () => {
    const records = fresh();
    await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")], submissions: [submission] }, 0);
    // Removing a submission, or changing what it holds, breaks the record invariants.
    expect(await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")] }, 1)).toEqual({ ok: false, code: "policy-violation" });
    expect(await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")], submissions: [{ ...submission, attempt: 2 }] }, 1))
      .toEqual({ ok: false, code: "policy-violation" });
    expect(await records.load()).toMatchObject({ version: 1, state: { submissions: [submission] } });
  });

  it("refuses to read records that do not match their schema", async () => {
    const records = fresh();
    await records.commit({ ...EMPTY, assignments: [assignment("Cell membranes essay")] }, 0);
    await runInDurableObject(records, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE ${ASSESSMENT_RECORDS_TABLE} SET state_json = ? WHERE id = 1`, JSON.stringify({ assignments: "nope" }));
      await expect(new DurableObjectAssessmentRecordStore(state.storage).load()).rejects.toBeInstanceOf(AssessmentRecordCorruptionError);
    });
  });
});
