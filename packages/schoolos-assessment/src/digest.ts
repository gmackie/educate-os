import type { ArtifactId, ContentDigest, RevisionId, SubmissionId } from "@schoolos/contracts";
import { sha256Digest } from "@schoolos/learning-artifacts";
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
  const canonical = canonicalItems(items).map(({ artifactId, revisionId, digest }) => ({ artifactId, revisionId, digest }));
  return encoder.encode(JSON.stringify({ format: "schoolos.submission-digest.v1", items: canonical }));
}

/** The combined submission digest: SHA-256 over {@link submissionDigestBytes}. */
export async function submissionDigest(items: readonly DigestedItem[]): Promise<ContentDigest> {
  return sha256Digest(submissionDigestBytes(items));
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
