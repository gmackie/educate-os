// The BLUEPRINT_CONTENT key the Workshop backend writes a bundled blueprint under when it installs
// it at first start: `<blueprintId>/<commit>`, where the commit is the blueprint's snapshot release
// (workshop-backend's buildSnapshotRelease()). Computed here, at build time, so that a release can
// name the exact objects its backend seeds, and uninstall can delete those and nothing else
// (SCHO-444). workshop-backend's bundled-blueprints test checks this against buildSnapshotRelease.
//
// A snapshot release is an ordinary git commit with a fixed signature and message over a tree of
// the files, so this is git's object encoding: blob, tree (canonical order) and commit.
import { createHash } from "node:crypto";

const ENCODER = new TextEncoder();

// workshop-backend's SNAPSHOT_SIGNATURE and SNAPSHOT_MESSAGE (blueprint-release.ts), formatted as
// encodeGitCommit() formats them: `<name> <<email>> <seconds> <+hhmm>`, and a message ending in
// one newline.
const SNAPSHOT_SIGNATURE = "Blueprint <blueprint@gadgets.invalid> 0 +0000";
const SNAPSHOT_MESSAGE = "Blueprint snapshot\n";

function objectId(type: "blob" | "tree" | "commit", payload: Uint8Array): Buffer {
  return createHash("sha1").update(`${type} ${payload.byteLength}\0`).update(payload).digest();
}

// Lexicographic order over unsigned bytes, a prefix first, as git compares tree entry names.
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  let length = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.byteLength - b.byteLength;
}

// The tree for a `path -> text` map: entries in git's canonical order, which compares a
// directory's name as if it ended in `/`.
function treeId(files: ReadonlyMap<string, string>): Buffer {
  let entries: { sortKey: Uint8Array; bytes: Buffer }[] = [];
  let directories = new Map<string, Map<string, string>>();
  for (let [path, text] of files) {
    let slash = path.indexOf("/");
    if (slash < 0) {
      let oid = objectId("blob", ENCODER.encode(text));
      entries.push({ sortKey: ENCODER.encode(path), bytes: Buffer.concat([Buffer.from(`100644 ${path}\0`), oid]) });
    } else {
      let name = path.slice(0, slash);
      let directory = directories.get(name) ?? new Map<string, string>();
      directories.set(name, directory.set(path.slice(slash + 1), text));
    }
  }
  for (let [name, directory] of directories) {
    entries.push({ sortKey: ENCODER.encode(`${name}/`), bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), treeId(directory)]) });
  }
  entries.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  return objectId("tree", Buffer.concat(entries.map((entry) => entry.bytes)));
}

/** The commit id of the snapshot release of `files`, as workshop-backend's buildSnapshotRelease() derives it. */
export function snapshotCommitId(files: ReadonlyMap<string, string>): string {
  let commit = `tree ${treeId(files).toString("hex")}\n` +
    `author ${SNAPSHOT_SIGNATURE}\ncommitter ${SNAPSHOT_SIGNATURE}\n\n${SNAPSHOT_MESSAGE}`;
  return objectId("commit", ENCODER.encode(commit)).toString("hex");
}

/** The BLUEPRINT_CONTENT key a bundled blueprint's content is installed under. */
export function bundledContentKey(blueprintId: string, files: ReadonlyMap<string, string>): string {
  return `${blueprintId}/${snapshotCommitId(files)}`;
}
