import type { ArtifactId, ContentDigest, RevisionId, SubmissionId } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";
import type { AssignmentId } from "./model.ts";

/** The part of a submission item its digest covers. */
export interface DigestedItem {
  artifactId: ArtifactId;
  revisionId: RevisionId;
  digest: ContentDigest;
}

const encoder = new TextEncoder();

/** Items in canonical order: by artifact ID. A submission names each artifact at most once. */
export function canonicalItems<T extends DigestedItem>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0));
}

/**
 * The canonical bytes a submission digest covers: JSON of the items in canonical order, each with
 * exactly `artifactId`, `revisionId` and `digest` in that order, and no whitespace. It depends on
 * the submitted revisions alone, not on who submitted them or when, so E02 can key an assessment
 * run on it and anyone holding the revisions can recompute it.
 */
export function submissionDigestBytes(items: readonly DigestedItem[]): Uint8Array<ArrayBuffer> {
  return digestBytes(DIGEST_FORMAT, items);
}

/** The combined submission digest: SHA-256 over {@link submissionDigestBytes}. */
export async function submissionDigest(items: readonly DigestedItem[]): Promise<ContentDigest> {
  return sha256Digest(submissionDigestBytes(items));
}

/**
 * Whether `expected` is the submission digest of `items`. Submissions made before the EducateOS
 * rename were digested under the legacy format name (SCHO-232), and their stored snapshots, run
 * keys and receipts keep that digest, so a digest under either name matches.
 */
export async function isSubmissionDigestOf(items: readonly DigestedItem[], expected: ContentDigest): Promise<boolean> {
  for (const format of [DIGEST_FORMAT, LEGACY_DIGEST_FORMAT]) {
    if ((await sha256Digest(digestBytes(format, items))) === expected) return true;
  }
  return false;
}

const DIGEST_FORMAT = "educateos.submission-digest.v1";
/** SCHO-232: the digest format name before the EducateOS rename. */
const LEGACY_DIGEST_FORMAT = "schoolos.submission-digest.v1";

function digestBytes(format: string, items: readonly DigestedItem[]): Uint8Array<ArrayBuffer> {
  const canonical = canonicalItems(items).map(({ artifactId, revisionId, digest }) => ({ artifactId, revisionId, digest }));
  return encoder.encode(JSON.stringify({ format, items: canonical }));
}

/**
 * The submission ID for one student's attempt at one assignment. It is derived rather than random
 * so that a submit retried after a partial failure pins its revisions under the same consumer
 * instead of leaving pins for a submission that never existed.
 */
export async function submissionIdFor(assignmentId: AssignmentId, studentPrincipalId: string, attempt: number): Promise<SubmissionId> {
  const digest = await sha256Digest(encoder.encode(JSON.stringify([assignmentId, studentPrincipalId, attempt])));
  return `sub_${digest.slice("sha256:".length, "sha256:".length + 40)}` as SubmissionId;
}
