import { z } from "zod";
import type { GitOid } from "@gadgets/gatekeeper-kit/git-objects";
import { ContentDigest, RevisionId, EducateOsError } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";
import { DIRECTORY_MODE, encodeTree, FILE_MODE, gitObject, type GitObject, type TreeEntryInput } from "./git-objects.ts";

/** The most files one project version may hold. */
export const MAX_PROJECT_FILES = 2000;
/** The largest single file in a project version. */
export const MAX_PROJECT_FILE_BYTES = 10 * 1024 * 1024;
/** The largest project version, all files together. */
export const MAX_PROJECT_BYTES = 50 * 1024 * 1024;

/** A lowercase, 40-digit SHA-1 Git object ID. */
export const ObjectId = z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-digit object ID");

/**
 * A file path inside a project: relative, `/`-separated, in Unicode NFC, with no empty, `.` or `..`
 * segment, no control characters, and no `.git` segment (which Git clients refuse to check out).
 */
export const ProjectPath = z
  .string()
  .min(1)
  .max(512)
  // oxlint-disable-next-line no-control-regex -- paths must not carry control characters
  .refine((p) => !/[\u0000-\u001f\u007f\\]/.test(p), "a path may not contain control characters or backslashes")
  .refine((p) => p === p.normalize("NFC"), "a path must be in Unicode NFC")
  .refine(
    (p) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git"),
    "a path must be relative, with no empty, '.', '..' or '.git' segment",
  );
/** A project path. */
export type ProjectPath = z.infer<typeof ProjectPath>;

/**
 * One file of the working tree a caller saves: UTF-8 `text` (stored byte-for-byte, never
 * canonicalized, since code and data must round-trip exactly) or raw `bytes`. `teacherOnly` marks a
 * file, such as an answer key, that must never reach a student: a baseline holding one in any
 * version cannot be forked (see `ProjectArtifacts.forkFromBaseline`).
 */
export const WorkingFile = z.union([
  z.strictObject({ path: ProjectPath, text: z.string(), teacherOnly: z.boolean().optional() }),
  z.strictObject({ path: ProjectPath, bytes: z.instanceof(Uint8Array), teacherOnly: z.boolean().optional() }),
]);
/** A working-tree file. */
export type WorkingFile = z.infer<typeof WorkingFile>;

/** A whole working tree: every file of the project, at most {@link MAX_PROJECT_FILES}. */
export const WorkingTree = z.array(WorkingFile).min(1).max(MAX_PROJECT_FILES);
/** A working tree. */
export type WorkingTree = z.infer<typeof WorkingTree>;

/** One file as a version records it: its path, size, SHA-256 and Git blob ID. Never its content. */
export const ManifestFile = z.strictObject({
  path: ProjectPath,
  sizeBytes: z.int().nonnegative(),
  sha256: ContentDigest,
  blob: ObjectId,
  teacherOnly: z.literal(true).optional(),
});
/** A manifest file entry. */
export type ManifestFile = z.infer<typeof ManifestFile>;

/** A Cloudflare Artifacts repository name: letters, digits, dots, hyphens and underscores. */
export const RepositoryName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
/** A repository name. */
export type RepositoryName = z.infer<typeof RepositoryName>;

/**
 * Where a version's files are:
 * - `artifacts-git`: a commit in the project's own Cloudflare Artifacts repository.
 * - `bundle`: inside the manifest itself, as base64 keyed by blob ID, where the district's plan has
 *   no Artifacts. learning-artifacts keeps the manifest inline as text or, when large, in R2.
 */
export const ProjectStorage = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("artifacts-git"), repository: RepositoryName, commit: ObjectId }),
  z.strictObject({ kind: z.literal("bundle"), blobs: z.record(ObjectId, z.base64()) }),
]);
/** Project storage. */
export type ProjectStorage = z.infer<typeof ProjectStorage>;

/**
 * What a project version saves as its learning-artifacts revision. The revision's own digest covers
 * this manifest; `contentDigest` and `tree` identify the files alone, so the same files give the
 * same values whichever storage holds them and whenever they were saved. Holds no credential.
 */
export const ProjectManifest = z.strictObject({
  format: z.literal("educateos.project.v1"),
  /** The saver's description of the version. */
  message: z.string().trim().min(1).max(500),
  /** SHA-256 over the canonical file listing (see {@link projectContentDigest}). */
  contentDigest: ContentDigest,
  /** The Git tree ID of the files. */
  tree: ObjectId,
  files: z.array(ManifestFile).max(MAX_PROJECT_FILES),
  storage: ProjectStorage,
});
/** A project manifest. */
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/**
 * The media type a project version is saved under. It is `text/*` so learning-artifacts keeps a
 * small manifest inline and a large one in R2; its JSON has no raw line breaks and NFC paths, so
 * the text canonicalization learning-artifacts applies leaves it unchanged.
 */
export const PROJECT_MANIFEST_MEDIA_TYPE = "text/vnd.educateos.project+json";

/** A working tree as Git objects, with the manifest entries and digest that describe it. */
export interface BuiltTree {
  tree: GitOid;
  contentDigest: ContentDigest;
  files: ManifestFile[];
  /** Every blob and tree object, root tree last. */
  objects: GitObject[];
  /** Each file's bytes, by blob ID. */
  blobs: Map<GitOid, Uint8Array<ArrayBuffer>>;
}

const encoder = new TextEncoder();

/**
 * Builds the Git objects for a working tree. Refuses duplicate paths, a path that is both a file
 * and a directory, and trees over the size limits.
 */
export async function buildTree(rawTree: WorkingTree): Promise<BuiltTree> {
  const parsed = WorkingTree.safeParse(rawTree);
  if (!parsed.success) throw invalid(z.prettifyError(parsed.error).slice(0, 1000));
  const files = parsed.data;
  const blobs = new Map<GitOid, Uint8Array<ArrayBuffer>>();
  const objects: GitObject[] = [];
  const entries: ManifestFile[] = [];
  const root: Directory = new Map();
  let total = 0;
  for (const file of files) {
    const bytes = "text" in file ? encoder.encode(file.text) : new Uint8Array(file.bytes);
    if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) throw invalid(`${file.path} is larger than a project file may be`);
    total += bytes.byteLength;
    if (total > MAX_PROJECT_BYTES) throw invalid("the project is larger than a version may be");
    const blob = await gitObject("blob", bytes);
    if (!blobs.has(blob.oid)) {
      blobs.set(blob.oid, bytes);
      objects.push(blob);
    }
    place(root, file.path, blob.oid);
    entries.push({
      path: file.path,
      sizeBytes: bytes.byteLength,
      sha256: await sha256Digest(bytes),
      blob: blob.oid,
      ...(file.teacherOnly === true ? { teacherOnly: true as const } : {}),
    });
  }
  const tree = await writeDirectory(root, objects);
  const sorted = entries.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { tree, contentDigest: await projectContentDigest(sorted), files: sorted, objects, blobs };
}

/**
 * SHA-256 over a version's canonical file listing: one `<path>\t<sha256>\t<size>\n` line per file,
 * sorted by path. It names exactly the files and their bytes, independent of storage and Git.
 */
export async function projectContentDigest(files: readonly ManifestFile[]): Promise<ContentDigest> {
  const lines = files
    .map((f) => `${f.path}\t${f.sha256}\t${f.sizeBytes}\n`)
    .toSorted();
  return sha256Digest(encoder.encode(lines.join("")));
}

function invalid(message: string): EducateOsError {
  return new EducateOsError("validation-failed", message);
}

/** A directory being built: a file's blob ID, or a subdirectory. */
type Directory = Map<string, GitOid | Directory>;

function place(root: Directory, path: string, blob: GitOid): void {
  const segments = path.split("/");
  let directory = root;
  for (const [index, segment] of segments.entries()) {
    const existing = directory.get(segment);
    if (index === segments.length - 1) {
      if (existing !== undefined) throw invalid(`${path} appears twice, or is also a directory`);
      directory.set(segment, blob);
      return;
    }
    if (typeof existing === "string") throw invalid(`${segments.slice(0, index + 1).join("/")} is both a file and a directory`);
    const child: Directory = existing ?? new Map();
    directory.set(segment, child);
    directory = child;
  }
}

async function writeDirectory(directory: Directory, objects: GitObject[]): Promise<GitOid> {
  const entries: TreeEntryInput[] = [];
  for (const [name, value] of directory) {
    entries.push(typeof value === "string"
      ? { name, mode: FILE_MODE, oid: value }
      : { name, mode: DIRECTORY_MODE, oid: await writeDirectory(value, objects) });
  }
  const tree = await gitObject("tree", encodeTree(entries));
  if (!objects.some((o) => o.oid === tree.oid)) objects.push(tree);
  return tree.oid;
}

/** One saved version of a project, as History lists it. */
export interface ProjectVersion {
  revisionId: RevisionId;
  /** 1 for the first version, increasing by one with each save. */
  number: number;
  message: string;
  savedAt: string;
  savedBy: string;
  contentDigest: ContentDigest;
  /** The digest learning-artifacts recorded for the revision, which receipts and submissions cite. */
  revisionDigest: ContentDigest;
  fileCount: number;
}
