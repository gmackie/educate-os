// Git object encoding: the write side that gatekeeper-kit's `git-objects` and `git-diff` (which
// parse commits and trees) do not cover. A project version is written as real, byte-exact Git
// objects so that Cloudflare Artifacts, `git clone` and the kit's tree diff all read it unchanged.
import { isCommitOid, type GitOid } from "@gadgets/gatekeeper-kit/git-objects";

/** The kinds of Git object a project version is made of. */
export type GitObjectType = "blob" | "tree" | "commit";

/** One Git object: its type, its payload (without the `<type> <size>\0` header), and its ID. */
export interface GitObject {
  type: GitObjectType;
  oid: GitOid;
  payload: Uint8Array<ArrayBuffer>;
}

/** The mode of a regular file. Project versions hold no executables, links or submodules. */
export const FILE_MODE = "100644";
/** The mode of a directory, as Git writes it in a tree. */
export const DIRECTORY_MODE = "40000";

const encoder = new TextEncoder();

/** UTF-8 bytes. TextEncoder always allocates a plain ArrayBuffer; Workers' types do not say so. */
function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

/** The SHA-1 object ID Git gives `payload` as an object of `type`. */
export async function gitObjectId(type: GitObjectType, payload: Uint8Array<ArrayBuffer>): Promise<GitOid> {
  const header = utf8(`${type} ${payload.byteLength}\0`);
  const whole = concat([header, payload]);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-1", whole)));
}

/** A Git object of `type` holding `payload`. */
export async function gitObject(type: GitObjectType, payload: Uint8Array<ArrayBuffer>): Promise<GitObject> {
  return { type, oid: await gitObjectId(type, payload), payload };
}

/** One entry of a tree being written. */
export interface TreeEntryInput {
  name: string;
  mode: typeof FILE_MODE | typeof DIRECTORY_MODE;
  oid: GitOid;
}

/**
 * A tree object's payload. Entries are sorted as Git sorts them, comparing a directory's name as
 * if it ended in `/`, so the same entries always give the tree Git itself would write.
 */
export function encodeTree(entries: readonly TreeEntryInput[]): Uint8Array<ArrayBuffer> {
  const sortKey = (e: TreeEntryInput) => utf8(e.mode === DIRECTORY_MODE ? `${e.name}/` : e.name);
  const sorted = entries.toSorted((a, b) => compareBytes(sortKey(a), sortKey(b)));
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of sorted) {
    if (!isCommitOid(entry.oid)) throw new Error(`invalid object ID in tree entry ${entry.name}`);
    parts.push(utf8(`${entry.mode} ${entry.name}\0`), unhex(entry.oid));
  }
  return concat(parts);
}

/** Who made a commit, and when. */
export interface CommitSignature {
  name: string;
  email: string;
  /** Seconds since the Unix epoch, recorded in UTC. */
  seconds: number;
}

/** The fields of a commit being written. */
export interface CommitInput {
  tree: GitOid;
  parents: readonly GitOid[];
  author: CommitSignature;
  message: string;
}

/** A commit object's payload. The committer is the author: EducateOS commits on its users' behalf. */
export function encodeCommit(commit: CommitInput): Uint8Array<ArrayBuffer> {
  for (const oid of [commit.tree, ...commit.parents]) {
    if (!isCommitOid(oid)) throw new Error("invalid object ID in commit");
  }
  const signature = signatureLine(commit.author);
  const lines = [
    `tree ${commit.tree}`,
    ...commit.parents.map((p) => `parent ${p}`),
    `author ${signature}`,
    `committer ${signature}`,
  ];
  const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
  return utf8(`${lines.join("\n")}\n\n${message}`);
}

/** Refuses a name or email that could break the signature line, as Git itself would. */
function signatureLine(signature: CommitSignature): string {
  // oxlint-disable-next-line no-control-regex -- rejecting control characters keeps the header well-formed
  if (/[<>\u0000-\u001f\u007f]/.test(signature.name + signature.email) || !Number.isSafeInteger(signature.seconds)) {
    throw new Error("invalid commit signature");
  }
  return `${signature.name} <${signature.email}> ${signature.seconds} +0000`;
}

const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

/**
 * A version 2 packfile holding `objects` whole (no deltas), as `git-receive-pack` accepts it: the
 * `PACK` header, each object's type-and-size header and zlib-deflated payload, and the SHA-1
 * trailer over everything before it.
 */
export async function encodePack(objects: readonly GitObject[]): Promise<Uint8Array<ArrayBuffer>> {
  const header = new Uint8Array(12);
  header.set(utf8("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array<ArrayBuffer>[] = [header];
  for (const object of objects) {
    parts.push(packObjectHeader(PACK_TYPE_CODES[object.type], object.payload.byteLength), await deflate(object.payload));
  }
  const body = concat(parts);
  const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return concat([body, trailer]);
}

/** A pack entry's header: the type in bits 4-6 of the first byte, the size in little-endian 7-bit groups. */
function packObjectHeader(typeCode: number, size: number): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  let byte = (typeCode << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  // "deflate" is the zlib format (RFC 1950) that packfiles use.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `parts` joined into one array. */
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(oid: GitOid): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(oid.slice(i * 2, i * 2 + 2), 16);
  return out;
}
