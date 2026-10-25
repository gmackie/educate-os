import type { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";
import {
  ArchiveProvenance,
  ArtifactRecord,
  CONTENT_ITEM_KINDS,
  FeedbackRecord,
  JSON_MEDIA_TYPE,
  MANIFEST_PATH,
  PROVENANCE_PATH,
  ResourceRecord,
  StudentArchiveManifest,
  SubmissionRecord,
  mayRedistribute,
  type ArchiveItem,
  type ArchiveItemKind,
  type SourceRights,
} from "./archive.ts";
import { findSecretShapes } from "./secrets.ts";
import { readZip } from "./zip.ts";

/**
 * A `.educateos` archive that passed {@link validateArchive}: every record parsed strictly, every
 * digest matched, every cross-reference resolved, and nothing in it is secret-shaped.
 */
export interface ValidatedArchive {
  manifest: StudentArchiveManifest;
  provenance: ArchiveProvenance;
  artifacts: ArtifactRecord[];
  submissions: SubmissionRecord[];
  feedback: FeedbackRecord[];
  resources: ResourceRecord[];
  /** The verified bytes of a content entry named by one of the records. Throws `not-found` for any other path. */
  content(path: string): Uint8Array<ArrayBuffer>;
}

/** The source-rights modes each item kind may carry. Content kinds must also be redistributable. */
const RIGHTS_BY_KIND: Readonly<Record<ArchiveItemKind, readonly SourceRights["mode"][]>> = {
  "artifact": ["learner-work", "link"],
  "artifact-revision": ["learner-work"],
  "submission": ["learner-work"],
  "submission-file": ["learner-work"],
  "feedback": ["shared-feedback"],
  "resource": ["link", "embed", "permitted-excerpt", "licensed-copy"],
  "resource-content": ["permitted-excerpt", "licensed-copy"],
  "provenance": ["export-metadata"],
};

const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid(message: string): EducateOsError {
  return new EducateOsError("validation-failed", `This is not a valid EducateOS archive: ${message}.`);
}

/**
 * Checks a `.educateos` archive without importing anything (importing into a district is P02):
 *
 * - the ZIP is read under `ARCHIVE_LIMITS` (entry count, sizes, compression ratio, safe relative
 *   paths, no overlapping entries);
 * - the manifest and every record parse against their strict schemas;
 * - the manifest lists exactly the archive's entries, and every digest and size matches;
 * - each item's source rights suit its kind, and only redistributable material is carried as content;
 * - every reference between records resolves, and each artifact's history is one linear chain;
 * - no entry holds secret-shaped text.
 *
 * Any failure rejects the whole archive with `validation-failed`.
 */
export async function validateArchive(bytes: Uint8Array<ArrayBuffer>): Promise<ValidatedArchive> {
  const entries = await readZip(bytes);
  const [first, ...rest] = entries;
  if (first?.path !== MANIFEST_PATH) throw invalid(`its first entry is not ${MANIFEST_PATH}`);
  const manifest = parseJson(StudentArchiveManifest, first.bytes, MANIFEST_PATH);
  screen(first.bytes, MANIFEST_PATH);

  if (rest.length !== manifest.items.length || rest.some((entry, i) => entry.path !== manifest.items[i]!.path)) {
    throw invalid("the manifest does not list exactly the archive's entries, in order");
  }
  const files = new Map<string, { item: ArchiveItem; bytes: Uint8Array<ArrayBuffer> }>();
  for (const [index, entry] of rest.entries()) {
    const item = manifest.items[index]!;
    if (entry.bytes.byteLength !== item.sizeBytes || (await sha256Digest(entry.bytes)) !== item.digest) {
      throw invalid(`${item.path} does not match its digest`);
    }
    if (!RIGHTS_BY_KIND[item.kind].includes(item.rights.mode)) throw invalid(`${item.path} carries rights its kind cannot have`);
    const isContent = CONTENT_ITEM_KINDS.includes(item.kind);
    if (isContent && !mayRedistribute(item.rights)) throw invalid(`${item.path} is content whose rights forbid redistribution`);
    if (!isContent && item.mediaType !== JSON_MEDIA_TYPE) throw invalid(`${item.path} is a record but not JSON`);
    if (item.mediaType.startsWith("text/") || item.mediaType === JSON_MEDIA_TYPE) screen(entry.bytes, item.path);
    files.set(item.path, { item, bytes: entry.bytes });
  }

  const recordsOf = <S extends z.ZodType>(kind: ArchiveItemKind, schema: S) =>
    manifest.items.filter((i) => i.kind === kind).map((i) => ({ path: i.path, rights: i.rights, record: parseJson(schema, files.get(i.path)!.bytes, i.path) }));
  const provenances = recordsOf("provenance", ArchiveProvenance);
  if (provenances.length !== 1 || provenances[0]!.path !== PROVENANCE_PATH) throw invalid(`it needs exactly one ${PROVENANCE_PATH}`);
  const provenance = provenances[0]!.record;
  if (provenance.exportId !== manifest.exportId) throw invalid("its provenance belongs to another export");

  const artifacts = recordsOf("artifact", ArtifactRecord);
  const submissions = recordsOf("submission", SubmissionRecord);
  const feedback = recordsOf("feedback", FeedbackRecord);
  const resources = recordsOf("resource", ResourceRecord);

  // Every content entry is named by exactly one record, with the same digest, type and size.
  const referenced = new Set<string>();
  const claim = (path: string, kind: ArchiveItemKind, digest: string, mediaType: string, sizeBytes: number, by: string) => {
    const file = files.get(path);
    if (file === undefined || file.item.kind !== kind) throw invalid(`${by} names ${path}, which is not a ${kind} entry`);
    if (referenced.has(path)) throw invalid(`${path} is named twice`);
    if (file.item.digest !== digest || file.item.mediaType !== mediaType || file.item.sizeBytes !== sizeBytes) {
      throw invalid(`${by} disagrees with the manifest about ${path}`);
    }
    referenced.add(path);
  };
  const isPerson = (ref: string) => !ref.startsWith("learner-") || ref === manifest.subject;

  const recordIds = new Set<string>();
  const unique = (id: string, path: string, expectedPath: string) => {
    if (recordIds.has(id)) throw invalid(`${id} appears twice`);
    if (path !== expectedPath) throw invalid(`${id} is stored at ${path} rather than ${expectedPath}`);
    recordIds.add(id);
  };

  const revisionDigests = new Map<string, { artifact: string; digest: string }>();
  for (const { path, rights, record } of artifacts) {
    unique(record.id, path, `artifacts/${record.id}/artifact.json`);
    const isLink = record.type === "external-ref";
    if ((rights.mode === "link") !== isLink) throw invalid(`${record.id}'s rights do not match its type`);
    for (const [index, revision] of record.revisions.entries()) {
      const previous = record.revisions[index - 1];
      if (revision.id !== `${record.id}-r${revision.number}`) throw invalid(`${revision.id} is misnamed`);
      if (previous !== undefined && revision.number <= previous.number) throw invalid(`${record.id}'s revisions are out of order`);
      if (revision.parent !== previous?.id) throw invalid(`${record.id}'s history is not one linear chain`);
      if (!isPerson(revision.author)) throw invalid(`${revision.id} names an unknown learner`);
      if ((revision.content.kind === "reference") !== isLink) throw invalid(`${revision.id}'s content does not match its artifact's type`);
      if (revision.content.kind === "file") {
        claim(revision.content.path, "artifact-revision", revision.digest, revision.mediaType, revision.sizeBytes, revision.id);
      }
      revisionDigests.set(revision.id, { artifact: record.id, digest: revision.digest });
    }
  }
  for (const { path, record } of submissions) {
    unique(record.id, path, `submissions/${record.id}/submission.json`);
    for (const part of record.parts) {
      if (part.content.kind === "revision") {
        const revision = revisionDigests.get(part.content.revision);
        if (revision?.artifact !== part.content.artifact || revision.digest !== part.digest) {
          throw invalid(`${record.id} names a revision the archive does not hold`);
        }
      } else if (part.content.kind === "file") {
        claim(part.content.path, "submission-file", part.digest, part.content.mediaType, part.content.sizeBytes, record.id);
      }
    }
  }
  const partCounts = new Map(submissions.map((s) => [s.record.id, s.record.parts.length]));
  for (const { path, record } of feedback) {
    unique(record.id, path, `feedback/${record.id}.json`);
    if (record.submission !== undefined && !partCounts.has(record.submission)) throw invalid(`${record.id} is about a submission the archive does not hold`);
    if (record.anchor !== undefined && record.anchor.part > (record.submission === undefined ? 0 : partCounts.get(record.submission)!)) {
      throw invalid(`${record.id} points at a part its submission does not have`);
    }
    if (!isPerson(record.author)) throw invalid(`${record.id} names an unknown learner`);
  }
  for (const { path, rights, record } of resources) {
    unique(record.id, path, `resources/${record.id}/resource.json`);
    if (record.content !== undefined) {
      if (!mayRedistribute(rights)) throw invalid(`${record.id} carries content its rights forbid redistributing`);
      claim(record.content.path, "resource-content", record.content.digest, record.content.mediaType, record.content.sizeBytes, record.id);
      if (files.get(record.content.path)!.item.rights.mode !== rights.mode) throw invalid(`${record.id}'s content carries different rights`);
    }
  }
  for (const item of manifest.items) {
    if (CONTENT_ITEM_KINDS.includes(item.kind) && !referenced.has(item.path)) throw invalid(`${item.path} is not named by any record`);
  }

  const decided = provenance.decisions.map((d) => d.item);
  if (decided.length !== recordIds.size || new Set(decided).size !== decided.length || decided.some((id) => !recordIds.has(id))) {
    throw invalid("its provenance does not account for exactly its items");
  }

  return {
    manifest,
    provenance,
    artifacts: artifacts.map((a) => a.record),
    submissions: submissions.map((s) => s.record),
    feedback: feedback.map((f) => f.record),
    resources: resources.map((r) => r.record),
    content(path) {
      const file = files.get(path);
      if (file === undefined || !referenced.has(path)) throw new EducateOsError("not-found", `${path} is not content in this archive.`);
      return file.bytes.slice();
    },
  };
}

function parseJson<S extends z.ZodType>(schema: S, bytes: Uint8Array<ArrayBuffer>, path: string): z.output<S> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalid(`${path} is not UTF-8 JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(`${path} does not match its schema (${parsed.error.issues[0]?.message ?? "invalid"})`);
  return parsed.data;
}

function screen(bytes: Uint8Array<ArrayBuffer>, path: string): void {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw invalid(`${path} is not UTF-8 text`);
  }
  const found = findSecretShapes(text);
  if (found.length > 0) throw invalid(`${path} holds secret-shaped text (${found.join(", ")})`);
}
