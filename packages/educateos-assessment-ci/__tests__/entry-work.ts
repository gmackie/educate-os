// Synthetic work with fixed IDs, for tests that drive the run engine directly.
import { ArtifactId, RevisionId } from "@educateos/contracts";
import { submissionDigest, type SubmissionItem } from "@educateos/assessment";
import { canonicalTextBytes, sha256Digest } from "@educateos/learning-artifacts";

/** One CSV dataset as submitted work, and its digest. */
export async function csvWork(text: string): Promise<{ items: SubmissionItem[]; submissionDigest: Awaited<ReturnType<typeof submissionDigest>> }> {
  const bytes = canonicalTextBytes(text);
  const items: SubmissionItem[] = [{
    artifactId: ArtifactId.parse("art_lab-data"),
    revisionId: RevisionId.parse("rev_lab-data-1"),
    digest: await sha256Digest(bytes),
    artifactType: "dataset",
    mediaType: "text/csv",
    sizeBytes: bytes.byteLength,
    aiAssistance: { level: "none" },
  }];
  return { items, submissionDigest: await submissionDigest(items) };
}
