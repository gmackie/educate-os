// SCHO-232: records stored and receipts signed before the EducateOS rename carry `schoolos.*` (rename-educateos: keep)
// format names and the `schoolos-submission-receipt/v1` signing context. They still parse and (rename-educateos: keep)
// verify, exactly as stored, while new records are written with the new names.
import { ArtifactId, ContentDigest, DistrictId, RevisionId, SubmissionId } from "@educateos/contracts";
import { SigningIdentity, canonicalJson } from "@educateos/fleet";
import { sha256Digest } from "@educateos/learning-artifacts";
import { describe, expect, it } from "vitest";
import {
  AssessmentState,
  AssignmentId,
  OfficialGradeVersion,
  SubmissionReceipt,
  isSubmissionDigestOf,
  signSubmissionReceipt,
  submissionDigest,
  verifySubmissionReceipt,
} from "../src/index.ts";
import { P, ref, withEssay } from "./setup.ts";

const NF = DistrictId.parse("dst_northfield");
const items = [{
  artifactId: ArtifactId.parse("art_essay"),
  revisionId: RevisionId.parse("rev_one"),
  digest: ContentDigest.parse(`sha256:${"a".repeat(64)}`),
}];

/** The submission digest exactly as the code before the rename computed it. */
async function legacyDigest(): Promise<ContentDigest> {
  return sha256Digest(new TextEncoder().encode(JSON.stringify({ format: "schoolos.submission-digest.v1", items }))); // rename-educateos: keep
}

async function receipt(format: string, digest: ContentDigest): Promise<SubmissionReceipt> {
  return SubmissionReceipt.parse({
    format,
    submissionId: SubmissionId.parse(`sub_${"b".repeat(40)}`),
    assignmentId: AssignmentId.parse("asg_essay"),
    studentPrincipalId: "prn_amara",
    attempt: 1,
    submittedAt: "2026-10-01T12:00:00.000Z",
    timing: "on-time",
    items,
    submissionDigest: digest,
  });
}

/** Signs `value` exactly as `signSubmissionReceipt` did before the rename. */
async function signLegacy(value: SubmissionReceipt, key: SigningIdentity) {
  const bytes = new TextEncoder().encode(`schoolos-submission-receipt/v1\0${NF}\0${canonicalJson(value)}`); // rename-educateos: keep
  return { receipt: value, districtId: NF, signature: { alg: "Ed25519", keyId: key.keyId, value: await key.sign(bytes) } };
}

describe("records from before the EducateOS rename", () => {
  it("match a submission digest computed under either format name, and nothing else", async () => {
    const legacy = await legacyDigest();
    expect(legacy).not.toBe(await submissionDigest(items));
    expect(await isSubmissionDigestOf(items, legacy)).toBe(true);
    expect(await isSubmissionDigestOf(items, await submissionDigest(items))).toBe(true);
    expect(await isSubmissionDigestOf(items, ContentDigest.parse(`sha256:${"0".repeat(64)}`))).toBe(false);
  });

  it("verify a receipt signed before the rename, exactly as it was kept", async () => {
    const key = await SigningIdentity.generate();
    const old = await receipt("schoolos.submission-receipt.v1", await legacyDigest()); // rename-educateos: keep
    const kept: unknown = JSON.parse(JSON.stringify(await signLegacy(old, key)));
    expect(await verifySubmissionReceipt(kept, NF, [key.publicKey])).toEqual(old);
    // The legacy context grants nothing beyond what it signed.
    const tampered = await signLegacy(old, key);
    expect(await verifySubmissionReceipt({ ...tampered, receipt: { ...old, timing: "late" } }, NF, [key.publicKey])).toBeUndefined();
    expect(await verifySubmissionReceipt(kept, NF, [(await SigningIdentity.generate()).publicKey])).toBeUndefined();
  });

  it("refuse a receipt of the current format signed under the legacy context", async () => {
    const key = await SigningIdentity.generate();
    const value = await receipt("educateos.submission-receipt.v1", await legacyDigest());
    expect(await verifySubmissionReceipt(await signLegacy(value, key), NF, [key.publicKey])).toBeUndefined();
  });

  it("verify a new receipt for a submission digested before the rename", async () => {
    const key = await SigningIdentity.generate();
    const value = await receipt("educateos.submission-receipt.v1", await legacyDigest());
    expect(await verifySubmissionReceipt(await signSubmissionReceipt(value, NF, key), NF, [key.publicKey])).toEqual(value);
  });

  it("parse a stored official grade with the legacy format, keeping its spelling", () => {
    const version = {
      format: "schoolos.official-grade.v1", // rename-educateos: keep
      districtId: NF,
      offeringId: "off_bio-fall",
      assignmentId: "asg_essay",
      studentPrincipalId: "prn_amara",
      submissionId: `sub_${"b".repeat(40)}`,
      submissionDigest: `sha256:${"c".repeat(64)}`,
      version: 1,
      score: { points: 17, maxPoints: 20 },
      approval: { approvedBy: "prn_morgan", approvedAt: "2026-10-02T12:00:00.000Z", channel: "http" },
    };
    expect(OfficialGradeVersion.parse(version).format).toBe("schoolos.official-grade.v1"); // rename-educateos: keep
    const state = { assignments: [], starterMaterials: [], submissions: [], feedback: [], gradeProposals: [], gradeVersions: [version] };
    expect(AssessmentState.parse(state).gradeVersions[0]).toEqual(version);
    expect(OfficialGradeVersion.safeParse({ ...version, format: "other.official-grade.v1" }).success).toBe(false);
  });

  it("still write the new names", async () => {
    const { assessment, assignment, essay } = await withEssay();
    const submitted = await assessment.submit(P.amara, assignment.id, [ref(essay)]);
    expect(submitted.format).toBe("educateos.submission-receipt.v1");
    expect(submitted.submissionDigest).toBe(await submissionDigest(submitted.items));
  });
});
