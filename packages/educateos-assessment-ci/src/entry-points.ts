// Assessment CI entry points besides a submission (roadmap §7): a reviewed checkpoint, a native
// Gadget result, manually uploaded work and a permitted external document snapshot. Each adapter
// turns its source into the same `SubmittedWork` a submission gives, with the digest a run key
// names, so every entry point converges on one immutable `AssessmentRun`.
import { z } from "zod";
import { ArtifactId, ArtifactType, ContentDigest, RevisionId, EducateOsError, type Caller, type OfferingId } from "@educateos/contracts";
import { canonicalItems, submissionDigest, type SubmissionItem } from "@educateos/assessment";
import { AiAssistance, MediaType, canonicalTextBytes, digestHex, isTextMediaType, sha256Digest, type LearningArtifacts } from "@educateos/learning-artifacts";
import type { SubmittedWork } from "./runs.ts";
import { XLSX_MEDIA_TYPE, xlsxToCsv, type XlsxToCsvOptions } from "./xlsx.ts";

/** Work from any entry point, ready to request a run on: what it is, how to read it, and its digest. */
export interface AssessableWork extends SubmittedWork {
  /** The digest of the work's items, as a run key's `submissionDigest` names it. */
  readonly submissionDigest: ContentDigest;
}

/** One piece of text work an adapter has already read, with what it carries into its item. */
interface TextPiece {
  artifactId: ArtifactId;
  revisionId: RevisionId;
  artifactType: ArtifactType;
  mediaType: MediaType;
  aiAssistance: AiAssistance;
  text: string;
}

const encoder = new TextEncoder();

/** An ID body derived from `parts`: stable, so the same source always names the same artifact or revision. */
async function derivedId(prefix: "art" | "rev", kind: string, ...parts: string[]): Promise<string> {
  const digest = await sha256Digest(encoder.encode(JSON.stringify([kind, ...parts])));
  return `${prefix}_${kind}-${digestHex(digest).slice(0, 40)}`;
}

/** Work made of text the adapter holds, digested the way artifact revisions are. */
async function heldTextWork(offeringId: OfferingId, pieces: readonly TextPiece[]): Promise<AssessableWork> {
  if (pieces.length === 0) throw new EducateOsError("validation-failed", "There is no work to assess.");
  if (new Set(pieces.map((p) => p.artifactId)).size !== pieces.length) throw new EducateOsError("validation-failed", "Each piece of work is named once.");
  const texts = new Map<ArtifactId, string>();
  const items: SubmissionItem[] = [];
  for (const piece of pieces) {
    const bytes = canonicalTextBytes(piece.text);
    items.push({
      artifactId: piece.artifactId,
      revisionId: piece.revisionId,
      digest: await sha256Digest(bytes),
      artifactType: piece.artifactType,
      mediaType: piece.mediaType,
      sizeBytes: bytes.byteLength,
      aiAssistance: piece.aiAssistance,
    });
    texts.set(piece.artifactId, piece.text);
  }
  const ordered = canonicalItems(items);
  return {
    items: ordered,
    offeringId,
    submissionDigest: await submissionDigest(ordered),
    readText: async (item) => {
      const text = texts.get(item.artifactId);
      if (text === undefined) throw new EducateOsError("not-found", `Artifact ${item.artifactId} is not part of this work.`);
      return text;
    },
  };
}

/** A revision of course work a teacher reviewed, to assess as it stands. */
export const CheckpointRef = z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId });
/** A checkpoint reference. */
export type CheckpointRef = z.infer<typeof CheckpointRef>;

/**
 * A reviewed checkpoint: exact revisions of a student's course work in `offeringId`, read through
 * the learning artifact service as `reviewer`, so only someone who may read the work can assess it.
 * Each revision must be `course` work in that offering. The run verifies each revision against its
 * digest when it reads it.
 */
export async function reviewedCheckpointWork(input: {
  artifacts: LearningArtifacts;
  reviewer: Caller;
  offeringId: OfferingId;
  checkpoints: readonly CheckpointRef[];
}): Promise<AssessableWork> {
  const refs = z.array(CheckpointRef).min(1).max(50).safeParse(input.checkpoints);
  if (!refs.success) throw new EducateOsError("validation-failed", "Name between one and fifty revisions to assess.");
  const items: SubmissionItem[] = [];
  for (const ref of refs.data) {
    const { artifact } = await input.artifacts.getArtifact(input.reviewer, ref.artifactId);
    if (artifact.classification !== "course" || artifact.scope.level !== "offering" || artifact.scope.offeringId !== input.offeringId) {
      throw new EducateOsError("not-found", `Artifact ${ref.artifactId} was not found.`);
    }
    const { revision } = await input.artifacts.readRevision(input.reviewer, artifact.id, ref.revisionId);
    items.push({
      artifactId: artifact.id,
      revisionId: revision.id,
      digest: revision.content.digest,
      artifactType: artifact.type,
      mediaType: revision.mediaType,
      sizeBytes: revision.sizeBytes,
      aiAssistance: revision.aiAssistance,
    });
  }
  if (new Set(items.map((i) => i.artifactId)).size !== items.length) throw new EducateOsError("validation-failed", "Each artifact is named once.");
  const ordered = canonicalItems(items);
  return {
    items: ordered,
    offeringId: input.offeringId,
    submissionDigest: await submissionDigest(ordered),
    readText: async (item) => {
      const { content } = await input.artifacts.readRevision(input.reviewer, item.artifactId, item.revisionId);
      if (content.kind !== "text") throw new EducateOsError("unavailable", `Artifact ${item.artifactId} is not text.`);
      return content.text;
    },
  };
}

/**
 * A result a native Gadget produced for a student, as text: CSV for tabular output, or plain text
 * or Markdown. `gadgetId` and `resultId` name it; the same result always becomes the same work.
 */
export const GadgetResult = z.strictObject({
  gadgetId: z.string().min(1).max(200),
  resultId: z.string().min(1).max(200),
  artifactType: ArtifactType,
  mediaType: MediaType.refine(isTextMediaType, "a Gadget result is assessed as text"),
  aiAssistance: AiAssistance,
  text: z.string().max(4 * 1024 * 1024),
});
/** A Gadget result. */
export type GadgetResult = z.infer<typeof GadgetResult>;

/** A native Gadget result as work to assess. */
export async function gadgetResultWork(offeringId: OfferingId, rawResult: GadgetResult): Promise<AssessableWork> {
  const result = parseInput(GadgetResult, rawResult);
  return heldTextWork(offeringId, [{
    artifactId: ArtifactId.parse(await derivedId("art", "gadget", result.gadgetId)),
    revisionId: RevisionId.parse(await derivedId("rev", "gadget", result.gadgetId, result.resultId)),
    artifactType: result.artifactType,
    mediaType: result.mediaType,
    aiAssistance: result.aiAssistance,
    text: result.text,
  }]);
}

/** One file a teacher uploaded for assessment: text, or an XLSX workbook, which is assessed as CSV. */
export const UploadedFile = z.strictObject({
  name: z.string().trim().min(1).max(200),
  artifactType: ArtifactType,
  mediaType: MediaType,
  aiAssistance: AiAssistance,
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array, "expected the file's bytes"),
});
/** An uploaded file. */
export type UploadedFile = z.infer<typeof UploadedFile>;

/**
 * Manually uploaded work. A text file is read as UTF-8; an XLSX workbook is converted to CSV
 * (`xlsxToCsv`) and assessed as a `text/csv` dataset; any other file is refused. The same files
 * always become the same work, since their IDs are derived from their names and content.
 */
export async function uploadedWork(offeringId: OfferingId, rawFiles: readonly UploadedFile[], options: { xlsx?: XlsxToCsvOptions } = {}): Promise<AssessableWork> {
  const files = parseInput(z.array(UploadedFile).min(1).max(20), rawFiles);
  const pieces: TextPiece[] = [];
  for (const file of files) {
    let text: string;
    let mediaType = file.mediaType;
    if (file.mediaType === XLSX_MEDIA_TYPE) {
      text = await xlsxToCsv(file.bytes, options.xlsx);
      mediaType = "text/csv";
    } else if (isTextMediaType(file.mediaType)) {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes);
      } catch {
        throw new EducateOsError("validation-failed", `${file.name} is not UTF-8 text.`);
      }
    } else {
      throw new EducateOsError("validation-failed", `${file.name} is ${file.mediaType}, which Assessment CI cannot read.`);
    }
    const digest = digestHex(await sha256Digest(canonicalTextBytes(text)));
    pieces.push({
      artifactId: ArtifactId.parse(await derivedId("art", "upload", file.name)),
      revisionId: RevisionId.parse(await derivedId("rev", "upload", file.name, digest)),
      artifactType: file.artifactType,
      mediaType,
      aiAssistance: file.aiAssistance,
      text,
    });
  }
  return heldTextWork(offeringId, pieces);
}

/**
 * A snapshot of an external document taken when it was permitted (for example a shared Google Doc
 * exported as text), with the digest recorded when it was taken.
 */
export const ExternalSnapshot = z.strictObject({
  url: z.url({ protocol: /^https$/ }).max(2048),
  snapshotDigest: ContentDigest,
  artifactType: ArtifactType,
  mediaType: MediaType.refine(isTextMediaType, "an external snapshot is assessed as text"),
  aiAssistance: AiAssistance,
  text: z.string().max(4 * 1024 * 1024),
});
/** An external document snapshot. */
export type ExternalSnapshot = z.infer<typeof ExternalSnapshot>;

/**
 * A permitted external document snapshot as work to assess. Its host must be one the district
 * approved, and its text must be exactly what `snapshotDigest` recorded; otherwise it is refused,
 * since a URL alone names a document that can change.
 */
export async function externalSnapshotWork(
  offeringId: OfferingId,
  rawSnapshot: ExternalSnapshot,
  approvedHosts: readonly string[],
): Promise<AssessableWork> {
  const snapshot = parseInput(ExternalSnapshot, rawSnapshot);
  if (!approvedHosts.includes(new URL(snapshot.url).hostname)) {
    throw new EducateOsError("forbidden", "That document's site is not one this district approved.");
  }
  if ((await sha256Digest(canonicalTextBytes(snapshot.text))) !== snapshot.snapshotDigest) {
    throw new EducateOsError("validation-failed", "The snapshot's text does not match the digest recorded when it was taken.");
  }
  return heldTextWork(offeringId, [{
    artifactId: ArtifactId.parse(await derivedId("art", "external", snapshot.url)),
    revisionId: RevisionId.parse(await derivedId("rev", "external", snapshot.url, snapshot.snapshotDigest)),
    artifactType: snapshot.artifactType,
    mediaType: snapshot.mediaType,
    aiAssistance: snapshot.aiAssistance,
    text: snapshot.text,
  }]);
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}
