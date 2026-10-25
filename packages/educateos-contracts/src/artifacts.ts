import { z } from "zod";
import { ArtifactId, RevisionId } from "./ids.ts";

/**
 * What a learning artifact is, and what a student may produce for an activity (roadmap §6.2).
 * `external-ref` is the one type whose content EducateOS does not hold: it records an approved link
 * to a Docs, Drive or LMS document.
 */
export const ArtifactType = z.enum([
  "document",
  "notebook",
  "spreadsheet",
  "presentation",
  "dataset",
  "image",
  "audio",
  "video",
  "interactive",
  "evidence",
  "portfolio",
  "external-ref",
]);
/** An artifact type. */
export type ArtifactType = z.infer<typeof ArtifactType>;

/**
 * A SHA-256 digest of canonical bytes, as `sha256:<64 lowercase hex>`. The same bytes always give
 * the same digest, so a receipt that commits to one names exactly the content it covers.
 */
export const ContentDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 hex digits>")
  .brand<"content-digest">();
/** A content digest. */
export type ContentDigest = z.infer<typeof ContentDigest>;

/** The reproducible identity of one revision's content, for receipts and submission snapshots. */
export const RevisionRef = z.strictObject({
  artifactId: ArtifactId,
  revisionId: RevisionId,
  digest: ContentDigest,
});
/** A revision reference. */
export type RevisionRef = z.infer<typeof RevisionRef>;
