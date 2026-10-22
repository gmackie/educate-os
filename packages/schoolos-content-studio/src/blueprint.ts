// A Workshop Blueprint release as Content Studio input (SCHO-121). A release is a git commit of the
// gadget's files (docs/blueprints.md, "Releases"); the studio identifies it by that commit and
// recomputes the commit from the files it is given, so the commit it pins is the code it reviewed.
// The tree and commit encodings follow `encodeGitTree`, `encodeGitCommit` and
// `buildSnapshotRelease` in packages/workshop-backend/src (git-codec.ts, blueprint-release.ts).
import { ResourceId, Scope, SchoolOsError } from "@schoolos/contracts";
import { z } from "zod";

/** A git object ID: 40 lowercase hex digits. A Blueprint release is named by its commit's. */
export const GitOid = z.string().regex(/^[0-9a-f]{40}$/, "expected a git object ID (40 lowercase hex digits)");
/** A git object ID. */
export type GitOid = z.infer<typeof GitOid>;

/** The most files one release may hold. Ample for a gadget; the bundled blueprints hold a dozen. */
export const MAX_BLUEPRINT_FILES = 2000;
/** The longest file path accepted, matching the Workshop's own cap. */
const MAX_PATH = 1024;

/**
 * One Blueprint release submitted for review. It names the release by its commit and carries its
 * files so the studio can check that commit. There is deliberately no field for the blueprint's
 * ID: in the Workshop that ID is a bearer share link to the code (docs/blueprints.md), and a
 * capability must never reach a registry record.
 */
export const BlueprintReleaseInput = z.strictObject({
  /** The district's name for the blueprint, such as `workspace-docs`. It is a label, not an ID. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, "expected a kebab-case blueprint name"),
  /** What the release was submitted as, for display: a `.gadget` file's name or a bundled blueprint's directory. */
  fileName: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  /** The blueprint's own version counter, as the Workshop shows it. */
  version: z.int().positive(),
  /** The release commit. */
  commitId: GitOid,
  /**
   * The release commit object's text, for a published release. Omitted for a snapshot release (a
   * bundled blueprint, or one stored before releases were commits), whose commit the files alone
   * determine.
   */
  commit: z.string().min(1).max(64 * 1024).optional(),
  /** The release's files, path to UTF-8 text, exactly as its tree holds them. */
  files: z.record(z.string().min(1).max(MAX_PATH), z.string())
    .refine((files) => Object.keys(files).length > 0, "a release holds at least one file")
    .refine((files) => Object.keys(files).length <= MAX_BLUEPRINT_FILES, `a release holds at most ${MAX_BLUEPRINT_FILES} files`),
});
/** A Blueprint release submission. */
export type BlueprintReleaseInput = z.infer<typeof BlueprintReleaseInput>;

/** A Blueprint release submission for review at a scope. */
export const SubmitBlueprintInput = z.strictObject({
  release: BlueprintReleaseInput,
  targetScope: Scope,
  /** Marks the submission as a new release of an already released resource. */
  updatesResourceId: ResourceId.optional(),
});
/** A Blueprint release submission for review. */
export type SubmitBlueprintInput = z.infer<typeof SubmitBlueprintInput>;

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** A git object's ID: SHA-1 over `<type> <size>\0` and the payload. */
async function objectId(type: "blob" | "tree" | "commit", payload: Uint8Array): Promise<GitOid> {
  const header = encoder.encode(`${type} ${payload.byteLength}\0`);
  const whole = new Uint8Array(header.byteLength + payload.byteLength);
  whole.set(header);
  whole.set(payload, header.byteLength);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", whole)));
}

const invalid = (message: string) => new SchoolOsError("validation-failed", `release.files: ${message}`);

/**
 * The ID of the git tree holding `files`, as the Workshop writes it: every file a mode `100644`
 * blob, directories as subtrees, entries in git's order, which compares names bytewise as if a
 * directory's ended in `/`.
 *
 * @throws SchoolOsError `validation-failed` for a path git cannot hold: an empty, `.` or `..`
 *   segment, a NUL, ill-formed Unicode, or a path that is both a file and a directory.
 */
export async function blueprintTreeId(files: ReadonlyMap<string, string>): Promise<GitOid> {
  const blobs = new Map<string, string>();
  const directories = new Map<string, Map<string, string>>();
  for (const [path, text] of files) {
    const slash = path.indexOf("/");
    const name = slash < 0 ? path : path.slice(0, slash);
    if (name === "" || name === "." || name === ".." || name.includes("\0") || !name.isWellFormed()) throw invalid(`${JSON.stringify(path)} is not a path git can hold`);
    if (slash < 0) blobs.set(name, text);
    else directories.set(name, (directories.get(name) ?? new Map<string, string>()).set(path.slice(slash + 1), text));
  }
  const entries: { sortKey: Uint8Array; bytes: Uint8Array }[] = [];
  const entry = (mode: string, name: string, oid: string, sortName: string) => {
    const head = encoder.encode(`${mode} ${name}\0`);
    const bytes = new Uint8Array(head.byteLength + 20);
    bytes.set(head);
    bytes.set(oid.match(/../g)!.map((pair) => Number.parseInt(pair, 16)), head.byteLength);
    entries.push({ sortKey: encoder.encode(sortName), bytes });
  };
  for (const [name, text] of blobs) {
    if (directories.has(name)) throw invalid(`${JSON.stringify(name)} is both a file and a directory`);
    entry("100644", name, await objectId("blob", encoder.encode(text)), name);
  }
  for (const [name, directory] of directories) entry("40000", name, await blueprintTreeId(directory), `${name}/`);
  entries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  const payload = new Uint8Array(entries.reduce((sum, e) => sum + e.bytes.byteLength, 0));
  let offset = 0;
  for (const { bytes } of entries) {
    payload.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return objectId("tree", payload);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.byteLength - b.byteLength;
}

/** The fixed identity, time and message of every snapshot release (`buildSnapshotRelease`). */
const SNAPSHOT_SIGNATURE = "Blueprint <blueprint@gadgets.invalid> 0 +0000";
const SNAPSHOT_MESSAGE = "Blueprint snapshot";

/** The commit text of the snapshot release of a tree: parentless, with a fixed author, date and message. */
export function snapshotReleaseCommit(treeId: GitOid): string {
  return `tree ${treeId}\nauthor ${SNAPSHOT_SIGNATURE}\ncommitter ${SNAPSHOT_SIGNATURE}\n\n${SNAPSHOT_MESSAGE}\n`;
}

/** A release whose commit was checked against its files. */
export interface VerifiedBlueprintRelease {
  commitId: GitOid;
  treeId: GitOid;
  /** Whether the commit is a snapshot release, determined by the files alone. */
  snapshot: boolean;
}

/**
 * Checks that `release.commitId` is the commit of `release.files`: the snapshot release of their
 * tree, or, when the commit's text is given, a commit with that ID whose tree is theirs.
 *
 * @throws SchoolOsError `validation-failed` if the files cannot form a git tree or the commit does
 *   not match them.
 */
export async function verifyBlueprintRelease(release: BlueprintReleaseInput): Promise<VerifiedBlueprintRelease> {
  const treeId = await blueprintTreeId(new Map(Object.entries(release.files)));
  const commit = release.commit ?? snapshotReleaseCommit(treeId);
  if (!commit.startsWith(`tree ${treeId}\n`)) throw new SchoolOsError("validation-failed", "release.commit: the commit's tree is not the release's files");
  if ((await objectId("commit", encoder.encode(commit))) !== release.commitId) {
    throw new SchoolOsError("validation-failed", "release.commitId: the commit does not match the release's files");
  }
  return { commitId: release.commitId, treeId, snapshot: release.commit === undefined };
}

/** The format tag of the release manifest the studio keeps for a Blueprint release in quarantine. */
export const BLUEPRINT_MANIFEST_FORMAT = "schoolos.blueprint-release/1";

/**
 * What the studio keeps of a Blueprint release in quarantine: its identity and each file's path,
 * size and blob ID, never the files. The code stays in the Workshop, which serves it by the
 * release commit, and runs only in a Gadget sandbox after the release is approved.
 */
export async function blueprintReleaseManifest(release: BlueprintReleaseInput, verified: VerifiedBlueprintRelease): Promise<Uint8Array> {
  const files = [];
  for (const path of Object.keys(release.files).toSorted()) {
    const bytes = encoder.encode(release.files[path]!);
    files.push({ path, bytes: bytes.byteLength, blob: await objectId("blob", bytes) });
  }
  return encoder.encode(JSON.stringify({
    format: BLUEPRINT_MANIFEST_FORMAT,
    name: release.name,
    title: release.title,
    version: release.version,
    commitId: verified.commitId,
    treeId: verified.treeId,
    files,
  }));
}

/** The registry locator of a Blueprint release: its name and pinned commit, never its blueprint ID. */
export function blueprintLocator(name: string, commitId: GitOid): string {
  return `urn:schoolos:blueprint:${name}:release:${commitId}`;
}
