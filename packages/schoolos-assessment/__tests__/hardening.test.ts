// SCHO-92: starter content outlives its source, teachers decline grade proposals and proposals
// expire, and submission receipts carry the district's signature for offline verification.
import { DistrictId } from "@schoolos/contracts";
import { NORTHFIELD } from "@schoolos/fixtures";
import { SigningIdentity } from "@schoolos/fleet";
import { describe, expect, it } from "vitest";
import { verifySubmissionReceipt, type GradeProposal } from "../src/index.ts";
import { O, P, doc, essayAssignment, ref, rejectsWith, setup, text, withEssay } from "./setup.ts";

const SCORE = { points: 17, maxPoints: 20 };
const NF = DistrictId.parse("dst_northfield");

describe("starter material retention", () => {
  it("keeps published starter content after the teacher deletes its source", async () => {
    const env = setup();
    const assignment = await env.assessment.createAssignment(P.morgan, essayAssignment());
    const personal = await env.workspaces.ensurePersonalWorkspace(P.morgan);
    const source = await env.artifacts.createArtifact(P.morgan, doc(personal.id, "Essay template.", "Essay starter"));
    await env.artifacts.saveRevision(P.morgan, source.artifact.id, text("Essay template, with my private grading notes."));
    const material = await env.assessment.publishStarterMaterial(P.morgan, assignment.id, { ...ref(source), revisionId: source.head.id, title: "Template" });

    await env.artifacts.deleteArtifact(P.morgan, source.artifact.id);
    // The published revision is pinned for the material and survives collection; the later one does not.
    const { state } = await env.artifactRecords.load();
    expect(state.revisions.filter((r) => r.artifactId === source.artifact.id).map((r) => r.id)).toEqual([source.head.id]);
    expect(state.pins).toContainEqual(expect.objectContaining({ revisionId: source.head.id, consumer: { kind: "baseline", baselineId: material.id } }));
    expect((await env.assessment.readStarterMaterial(P.amara, assignment.id, material.id)).content).toEqual({ kind: "text", text: "Essay template." });
    // The teacher's own `keep` pins are theirs to release; a baseline pin is not.
    await rejectsWith(env.artifacts.unpin(P.morgan, source.artifact.id, source.head.id), "not-found");
  });
});

/** Amara's submitted essay, with a grade her teacher's agent proposed. */
async function proposed() {
  const env = await withEssay(P.amara, "Membranes are selectively permeable because of the lipid bilayer.");
  const receipt = await env.assessment.submit(P.amara, env.assignment.id, [ref(env.essay)]);
  const outcome = await env.assessment.recordOfficialGrade(P.morganAgent, { submissionId: receipt.submissionId, score: SCORE });
  if (outcome.status !== "pending-approval") throw new Error(`expected a proposal, got ${outcome.status}`);
  return { ...env, receipt, submissionId: receipt.submissionId, proposal: outcome.proposal };
}

describe("grade proposals", () => {
  it("can be declined, with a reason, only by a teacher of the offering acting directly", async () => {
    const { assessment, assignment, proposal } = await proposed();
    await rejectsWith(assessment.declineGradeProposal(P.morgan, proposal.id, "   "), "validation-failed");
    await rejectsWith(assessment.declineGradeProposal(P.morganAgent, proposal.id, "Not my call."), "forbidden");
    await rejectsWith(assessment.declineGradeProposal(P.amara, proposal.id, "I want more."), "forbidden");
    await rejectsWith(assessment.declineGradeProposal(P.elena, proposal.id, "No."), "not-found");

    const declined = await assessment.declineGradeProposal(P.morgan, proposal.id, "The thesis section needs another read.");
    expect(declined.declined).toMatchObject({ declinedBy: P.morgan.principal.principalId, reason: "The thesis section needs another read." });
    // Declining again changes nothing; it never becomes official and no longer waits.
    expect(await assessment.declineGradeProposal(P.morgan, proposal.id, "Again.")).toEqual(declined);
    await rejectsWith(assessment.approveGradeProposal(P.morgan, proposal.id), "conflict");
    expect(await assessment.pendingGradeProposals(P.morgan, assignment.id)).toEqual([]);
    expect(await assessment.officialGrades(P.morgan, assignment.id, P.amara.principal.principalId)).toEqual([]);
  });

  it("expire when the student withdraws the work they grade", async () => {
    const { assessment, assignment, submissionId, proposal, records } = await proposed();
    await assessment.withdraw(P.amara, submissionId);
    const stored = (await records.load()).state.gradeProposals.find((p) => p.id === proposal.id);
    expect(stored?.expired).toMatchObject({ cause: "submission-withdrawn" });
    await rejectsWith(assessment.approveGradeProposal(P.morgan, proposal.id), "conflict");
    await rejectsWith(assessment.declineGradeProposal(P.morgan, proposal.id, "Too late."), "conflict");
    expect(await assessment.pendingGradeProposals(P.morgan, assignment.id)).toEqual([]);
  });

  it("expire when a newer official version is approved, so an old proposal cannot overwrite it", async () => {
    const { assessment, assignment, submissionId, proposal, records } = await proposed();
    const second = await assessment.recordOfficialGrade(P.morganAgent, { submissionId, score: { points: 12, maxPoints: 20 } });
    if (second.status !== "pending-approval") throw new Error("expected a second proposal");

    const official = await assessment.approveGradeProposal(P.morgan, second.proposal.id);
    const first = (await records.load()).state.gradeProposals.find((p) => p.id === proposal.id);
    expect(first?.expired).toMatchObject({ cause: "superseded", supersededBy: official.version });
    await rejectsWith(assessment.approveGradeProposal(P.morgan, proposal.id), "conflict");

    // A grade the teacher enters directly supersedes waiting proposals too.
    const third = await assessment.recordOfficialGrade(P.morganAgent, { submissionId, score: { points: 15, maxPoints: 20 } });
    if (third.status !== "pending-approval") throw new Error("expected a third proposal");
    const direct = await assessment.recordOfficialGrade(P.morgan, { submissionId, score: SCORE });
    if (direct.status !== "official") throw new Error("expected an official grade");
    expect((await records.load()).state.gradeProposals.find((p) => p.id === third.proposal.id)?.expired).toMatchObject({ supersededBy: direct.version.version });
    expect(await assessment.pendingGradeProposals(P.morgan, assignment.id)).toEqual([]);
  });

  it("never change once decided, whatever writes to the store", async () => {
    const { assessment, proposal, records } = await proposed();
    await assessment.declineGradeProposal(P.morgan, proposal.id, "Re-read the rubric.");
    const { state, version } = await records.load();
    const rewrite = (change: (p: GradeProposal) => GradeProposal) =>
      records.commit({ ...state, gradeProposals: state.gradeProposals.map((p) => (p.id === proposal.id ? change(p) : p)) }, version);
    await rejectsWith(rewrite(({ declined: _declined, ...p }) => p), "policy-violation");
    await rejectsWith(rewrite((p) => ({ ...p, score: { points: 20, maxPoints: 20 } })), "policy-violation");
    await rejectsWith(records.commit({ ...state, gradeProposals: [] }, version), "policy-violation");
  });
});

describe("signed submission receipts", () => {
  async function signedSetup() {
    const key = await SigningIdentity.generate();
    const env = setup(NORTHFIELD, { receiptKey: key });
    const assignment = await env.assessment.createAssignment(P.morgan, essayAssignment());
    const workspace = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const essay = await env.artifacts.createArtifact(P.amara, doc(workspace.id, "Membranes are selectively permeable."));
    const receipt = await env.assessment.submit(P.amara, assignment.id, [ref(essay)]);
    return { ...env, key, receipt };
  }

  it("verify offline against the district's public key, and only for exactly the receipt signed", async () => {
    const { assessment, key, receipt } = await signedSetup();
    const signed = await assessment.signedReceipt(P.amara, receipt.submissionId);
    expect(signed.receipt).toEqual(receipt);
    // A teacher of the offering gets the same receipt.
    expect((await assessment.signedReceipt(P.morgan, receipt.submissionId)).receipt).toEqual(receipt);

    // Round-tripped through JSON, as a student would keep it.
    const kept: unknown = JSON.parse(JSON.stringify(signed));
    expect(await verifySubmissionReceipt(kept, NF, [key.publicKey])).toEqual(receipt);

    const other = await SigningIdentity.generate();
    expect(await verifySubmissionReceipt(kept, NF, [other.publicKey])).toBeUndefined();
    expect(await verifySubmissionReceipt(kept, DistrictId.parse("dst_riverbend"), [key.publicKey])).toBeUndefined();
    expect(await verifySubmissionReceipt({ ...signed, receipt: { ...signed.receipt, timing: "late" } }, NF, [key.publicKey])).toBeUndefined();
    expect(await verifySubmissionReceipt({ ...signed, districtId: "dst_riverbend" }, NF, [key.publicKey])).toBeUndefined();
    // A receipt whose digest does not cover its items is refused even with a valid signature over it.
    const wrongDigest = { ...receipt, items: receipt.items.map((i) => ({ ...i, digest: `sha256:${"0".repeat(64)}` })) };
    const forged = { ...signed, receipt: wrongDigest };
    expect(await verifySubmissionReceipt(forged, NF, [key.publicKey])).toBeUndefined();
  });

  it("are only for those who may read the submission, and only where the district signs them", async () => {
    const { assessment, receipt } = await signedSetup();
    await rejectsWith(assessment.signedReceipt(P.elena, receipt.submissionId), "not-found");
    const unsigned = await withEssay();
    const own = await unsigned.assessment.submit(P.amara, unsigned.assignment.id, [ref(unsigned.essay)]);
    await rejectsWith(unsigned.assessment.signedReceipt(P.amara, own.submissionId), "unavailable");
  });
});
