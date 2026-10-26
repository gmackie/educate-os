import { ArtifactType, ContentDigest } from "@educateos/contracts";
import { AnchorRegion } from "@educateos/assessment";
import { z } from "zod";
import {
  AiAssistance,
  MediaType,
  ProvenanceRecord,
  sha256Digest,
} from "@educateos/learning-artifacts";
import { ArchiveGenerator, recordFormat } from "./legacy-formats.ts";
import { isSafeEntryPath, writeZip } from "./zip.ts";

/**
 * The `.educateos` student archive, format version 1 (roadmap P01). The archive is a ZIP holding
 * `manifest.json`, which lists every other entry with its digest and source rights, a provenance
 * file, and one JSON record per artifact, submission, feedback note and cited resource, beside the
 * content files those records name. `docs/educateos/educateos-archive-format.md` is the format's
 * specification.
 *
 * Every identifier in an archive is export-local. District principal, artifact, revision,
 * submission and workspace IDs never appear: the schemas below only accept local ID shapes, and
 * the mapping back to internal IDs stays with the exporting district.
 */

/** The value of `manifest.format` this package writes. */
export const ARCHIVE_FORMAT = "educateos.student-archive";
/** The archive format version this package writes and reads. */
export const ARCHIVE_FORMAT_VERSION = 1;
/** The path of the manifest, always the first entry. */
export const MANIFEST_PATH = "manifest.json";
/** The path of the provenance file. */
export const PROVENANCE_PATH = "provenance.json";
/** The media type of `.educateos` files. */
export const ARCHIVE_MEDIA_TYPE = "application/vnd.educateos.student-archive+zip";
/** The media type every JSON record in an archive is listed under. */
export const JSON_MEDIA_TYPE: MediaType = "application/json";

/** Identifies one export: 32 lowercase hex digits, random per export. */
export const ExportId = z.string().regex(/^[0-9a-f]{32}$/, "expected an export ID").brand<"export">();
/** An export identifier. */
export type ExportId = z.infer<typeof ExportId>;

/** The export-local reference to the learner the archive is about. It is never their principal ID. */
export const SubjectRef = z.string().regex(/^learner-[0-9a-f]{16}$/, "expected a learner reference").brand<"subject-ref">();
/** A subject reference. */
export type SubjectRef = z.infer<typeof SubjectRef>;

/** Who wrote something: the learner, or a staff member under an export-local pseudonym (`staff-1`). */
export const PersonRef = z.union([SubjectRef, z.string().regex(/^staff-[1-9][0-9]{0,5}$/, "expected a staff pseudonym")]);
/** A person reference. */
export type PersonRef = z.infer<typeof PersonRef>;

/** An export-local artifact ID (`a1`). */
export const ArtifactLocalId = z.string().regex(/^a[1-9][0-9]{0,5}$/, "expected a local artifact ID");
/** An export-local revision ID (`a1-r3`): the artifact's local ID and the revision's number. */
export const RevisionLocalId = z.string().regex(/^a[1-9][0-9]{0,5}-r[1-9][0-9]{0,5}$/, "expected a local revision ID");
/** An export-local submission ID (`s1`). */
export const SubmissionLocalId = z.string().regex(/^s[1-9][0-9]{0,5}$/, "expected a local submission ID");
/** An export-local feedback ID (`f1`). */
export const FeedbackLocalId = z.string().regex(/^f[1-9][0-9]{0,5}$/, "expected a local feedback ID");
/** An export-local resource ID (`res1`). */
export const ResourceLocalId = z.string().regex(/^res[1-9][0-9]{0,5}$/, "expected a local resource ID");

/** An archive entry path (see `isSafeEntryPath`). */
export const ArchivePath = z.string().refine(isSafeEntryPath, "expected a safe relative path");

/**
 * An `https` link exported as a reference. It never carries credentials, a query or a fragment,
 * where share tokens and signatures live; the exporter strips them.
 */
export const ReferenceUrl = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  }, "a reference URL carries no credentials, query or fragment");

/**
 * Where an item came from, and so whether it may be carried as content:
 * - `learner-work`: made by the learner in EducateOS.
 * - `shared-feedback`: written by the learner's teachers and shared with the learner.
 * - `export-metadata`: written by the export itself.
 * - `link` and `embed`: third-party material that may be pointed at, never copied.
 * - `permitted-excerpt` and `licensed-copy`: third-party material that may be copied only when its
 *   license permits redistribution.
 */
export const SourceRights = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("learner-work") }),
  z.strictObject({ mode: z.literal("shared-feedback") }),
  z.strictObject({ mode: z.literal("export-metadata") }),
  z.strictObject({ mode: z.literal("link") }),
  z.strictObject({ mode: z.literal("embed") }),
  z.strictObject({
    mode: z.literal("permitted-excerpt"),
    redistribution: z.enum(["permitted", "forbidden"]),
    license: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({
    mode: z.literal("licensed-copy"),
    redistribution: z.enum(["permitted", "forbidden"]),
    license: z.string().min(1).max(200).optional(),
  }),
]);
/** Source rights. */
export type SourceRights = z.infer<typeof SourceRights>;

/** Whether material under `rights` may be carried in an archive as content, rather than as a reference. */
export function mayRedistribute(rights: SourceRights): boolean {
  switch (rights.mode) {
    case "learner-work":
    case "shared-feedback":
    case "export-metadata":
      return true;
    case "link":
    case "embed":
      return false;
    case "permitted-excerpt":
    case "licensed-copy":
      return rights.redistribution === "permitted";
  }
}

/** What an archive entry is. */
export const ArchiveItemKind = z.enum([
  "artifact",
  "artifact-revision",
  "submission",
  "submission-file",
  "feedback",
  "resource",
  "resource-content",
  "provenance",
]);
/** An archive item kind. */
export type ArchiveItemKind = z.infer<typeof ArchiveItemKind>;

/** The item kinds whose entries are content files, rather than JSON records. */
export const CONTENT_ITEM_KINDS: readonly ArchiveItemKind[] = ["artifact-revision", "submission-file", "resource-content"];

/** One entry of the archive, as the manifest lists it. */
export const ArchiveItem = z.strictObject({
  path: ArchivePath,
  kind: ArchiveItemKind,
  /** SHA-256 over the entry's bytes. For a revision's content this is also the revision's own digest. */
  digest: ContentDigest,
  sizeBytes: z.int().nonnegative(),
  mediaType: MediaType,
  rights: SourceRights,
});
/** An archive item. */
export type ArchiveItem = z.infer<typeof ArchiveItem>;

/** `manifest.json`: what the archive is, who it is about, and every other entry in it. */
export const StudentArchiveManifest = z.strictObject({
  format: recordFormat("student-archive"),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  exportId: ExportId,
  /** The exporting district, by display name only. */
  district: z.strictObject({ displayName: z.string().min(1).max(200) }),
  exportedAt: z.iso.datetime(),
  subject: SubjectRef,
  /** Every entry except the manifest, in archive order. */
  items: z.array(ArchiveItem).max(9_999),
});
/** An archive manifest. */
export type StudentArchiveManifest = z.infer<typeof StudentArchiveManifest>;

/** Where a piece of work was made, by display name: a personal workspace, or a course section and term. */
export const WorkContext = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("personal") }),
  z.strictObject({
    kind: z.literal("course"),
    course: z.string().min(1).max(200),
    section: z.string().min(1).max(200),
    term: z.string().min(1).max(200),
  }),
]);
/** A work context. */
export type WorkContext = z.infer<typeof WorkContext>;

/** One revision of an exported artifact. Its content is a file in the archive or, for a link, a reference. */
export const ArchivedRevision = z.strictObject({
  id: RevisionLocalId,
  number: z.int().positive(),
  /** The revision it was saved on top of. Absent for the first. */
  parent: RevisionLocalId.optional(),
  createdAt: z.iso.datetime(),
  author: PersonRef,
  mediaType: MediaType,
  /** The revision's content digest in the district, so a receipt for it can be checked against this archive. */
  digest: ContentDigest,
  sizeBytes: z.int().nonnegative(),
  aiAssistance: AiAssistance,
  origin: ProvenanceRecord.shape.origin,
  content: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("file"), path: ArchivePath }),
    z.strictObject({ kind: z.literal("reference"), url: ReferenceUrl, snapshotDigest: ContentDigest.optional() }),
  ]),
});
/** An archived revision. */
export type ArchivedRevision = z.infer<typeof ArchivedRevision>;

/** `artifacts/<id>/artifact.json`: an artifact and its whole stored revision lineage, oldest first. */
export const ArtifactRecord = z.strictObject({
  id: ArtifactLocalId,
  type: ArtifactType,
  title: z.string().min(1).max(200),
  context: WorkContext,
  createdAt: z.iso.datetime(),
  revisions: z.array(ArchivedRevision).min(1).max(10_000),
});
/** An artifact record. */
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

/**
 * One part of a submission: a revision exported with its artifact (whose record gives its type and
 * size), a file of its own, or one not included.
 */
export const SubmissionPart = z.strictObject({
  /** The submitted revision's content digest. */
  digest: ContentDigest,
  content: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("revision"), artifact: ArtifactLocalId, revision: RevisionLocalId }),
    z.strictObject({ kind: z.literal("file"), path: ArchivePath, mediaType: MediaType, sizeBytes: z.int().nonnegative() }),
    /** The district no longer holds the submitted content, or may not export it; the digest still identifies it. */
    z.strictObject({ kind: z.literal("not-included") }),
  ]),
});
/** A submission part. */
export type SubmissionPart = z.infer<typeof SubmissionPart>;

/** `submissions/<id>/submission.json`: one of the learner's submissions. */
export const SubmissionRecord = z.strictObject({
  id: SubmissionLocalId,
  /** The activity's title. */
  activity: z.string().min(1).max(200),
  context: WorkContext,
  submittedAt: z.iso.datetime(),
  parts: z.array(SubmissionPart).max(100),
});
/** A submission record. */
export type SubmissionRecord = z.infer<typeof SubmissionRecord>;

/** `feedback/<id>.json`: feedback a teacher shared with the learner. */
export const FeedbackRecord = z.strictObject({
  id: FeedbackLocalId,
  /** The submission it is about, when that submission is in the archive. */
  submission: SubmissionLocalId.optional(),
  author: PersonRef,
  createdAt: z.iso.datetime(),
  body: z.string().min(1).max(100_000),
  /**
   * Where in the submission it points: a place (a text range or an area) in one of its parts,
   * numbered from 1 in the submission's order. Only present with `submission`.
   */
  anchor: z.strictObject({ part: z.int().min(1).max(100), region: AnchorRegion }).optional(),
});
/** A feedback record. */
export type FeedbackRecord = z.infer<typeof FeedbackRecord>;

/** `resources/<id>/resource.json`: a learning resource the learner's work cites, as a reference, as content, or both. */
export const ResourceRecord = z
  .strictObject({
    id: ResourceLocalId,
    title: z.string().min(1).max(200),
    reference: z.strictObject({ url: ReferenceUrl }).optional(),
    content: z.strictObject({ path: ArchivePath, mediaType: MediaType, digest: ContentDigest, sizeBytes: z.int().nonnegative() }).optional(),
  })
  .refine((r) => r.reference !== undefined || r.content !== undefined, "a resource is exported as a reference or as content");
/** A resource record. */
export type ResourceRecord = z.infer<typeof ResourceRecord>;

/** One policy decision that let an item into the archive. */
export const ExportDecision = z.strictObject({
  /** The item's local ID. */
  item: z.string().regex(/^(?:a|s|f|res)[1-9][0-9]{0,5}$/),
  /** What was asked: `export` for content, `read` for a resource exported only as a reference. */
  action: z.enum(["export", "read"]),
  /** The district policy rule that allowed it. */
  ruleId: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/).max(128),
});
/** An export decision. */
export type ExportDecision = z.infer<typeof ExportDecision>;

/** `provenance.json`: what produced the archive, and the policy decision behind every item in it. */
export const ArchiveProvenance = z.strictObject({
  format: recordFormat("student-archive.provenance"),
  formatVersion: z.literal(ARCHIVE_FORMAT_VERSION),
  exportId: ExportId,
  generator: ArchiveGenerator,
  decisions: z.array(ExportDecision).max(10_000),
});
/** Archive provenance. */
export type ArchiveProvenance = z.infer<typeof ArchiveProvenance>;

/** One entry to write, before its digest is taken. */
export interface ArchiveFile {
  path: string;
  kind: ArchiveItemKind;
  mediaType: MediaType;
  rights: SourceRights;
  bytes: Uint8Array<ArrayBuffer>;
}

/** What the manifest says beside its item list. */
export type ArchiveHeader = Omit<StudentArchiveManifest, "format" | "formatVersion" | "items">;

const encoder = new TextEncoder();

/**
 * JSON with object keys in sorted order and no whitespace, the form every record in an archive is
 * written in, so the same record always gives the same bytes.
 */
export function canonicalJsonBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  ));
}

/**
 * Writes an archive: the manifest first, then every file in path order. The bytes depend only on
 * `header` and `files`, never on the order files were collected in or on the clock.
 */
export async function writeArchive(header: ArchiveHeader, files: readonly ArchiveFile[]): Promise<{ bytes: Uint8Array<ArrayBuffer>; manifest: StudentArchiveManifest }> {
  const sorted = files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const items: ArchiveItem[] = [];
  for (const file of sorted) {
    items.push({ path: file.path, kind: file.kind, digest: await sha256Digest(file.bytes), sizeBytes: file.bytes.byteLength, mediaType: file.mediaType, rights: file.rights });
  }
  const manifest = StudentArchiveManifest.parse({ format: ARCHIVE_FORMAT, formatVersion: ARCHIVE_FORMAT_VERSION, ...header, items });
  const bytes = await writeZip([{ path: MANIFEST_PATH, bytes: canonicalJsonBytes(manifest) }, ...sorted.map((f) => ({ path: f.path, bytes: f.bytes }))]);
  return { bytes, manifest };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "json",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};

/** The file extension content of `mediaType` is written with. Unknown types are `bin`. */
export function extensionFor(mediaType: MediaType): string {
  return EXTENSIONS[mediaType] ?? "bin";
}
