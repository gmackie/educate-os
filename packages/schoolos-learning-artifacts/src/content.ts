import { SchoolOsError, type ArtifactType, type ContentDigest } from "@schoolos/contracts";
import { digestHex, sha256Digest } from "./digest.ts";
import type { ContentProviderName, ContentRef, HeldContentRef, MediaType, RegisteredContentRef } from "./model.ts";

/**
 * The largest text revision kept inline, in canonical bytes: comfortably an essay or a lab's CSV.
 * Larger text goes to R2.
 */
export const INLINE_TEXT_LIMIT_BYTES = 64 * 1024;

/** Types whose content is a recording or picture, kept in R2 whatever its media type says. */
const MEDIA_TYPES: readonly ArtifactType[] = ["image", "audio", "video"];

/** Whether a media type is text, which is canonicalized and may be kept inline. */
export function isTextMediaType(mediaType: MediaType): boolean {
  return mediaType.startsWith("text/");
}

/**
 * Where a revision's content goes, unless a registered provider already holds it. Pure: the same
 * type, media type and size always choose the same backend. An `external-ref` is never held; small
 * text is kept inline; everything else, including every image, recording and video, is an R2 object.
 */
export function chooseBackend(input: { type: ArtifactType; mediaType: MediaType; sizeBytes: number }): "text" | "r2" | "external" {
  if (input.type === "external-ref") return "external";
  if (MEDIA_TYPES.includes(input.type)) return "r2";
  return isTextMediaType(input.mediaType) && input.sizeBytes <= INLINE_TEXT_LIMIT_BYTES ? "text" : "r2";
}

/**
 * A content backend another package registers, such as `@schoolos/artifacts-git`'s project
 * versions in Cloudflare Artifacts. The provider writes its content itself and hands learning-
 * artifacts a {@link RegisteredContentRef}; learning-artifacts reads it back through `read` and
 * checks the bytes against the reference's digest, before recording a revision and on every read.
 */
export interface ContentProvider {
  /** The name references to this provider carry. */
  readonly name: ContentProviderName;
  /** The bytes `ref` names, or null if the provider no longer has them. */
  read(ref: RegisteredContentRef): Promise<Uint8Array<ArrayBuffer> | null>;
}

/**
 * Holds revision content by digest. Writes are idempotent, since a key names its content; every
 * read verifies the bytes against the reference's digest and answers `unavailable` if they differ.
 * An external reference is never read: SchoolOS does not hold its content. Registered content is
 * read through its provider.
 */
export interface ArtifactStore {
  /** Stores `bytes`, whose digest the caller computed, in `backend`, and returns the reference. */
  write(backend: HeldContentRef["backend"], bytes: Uint8Array<ArrayBuffer>, digest: ContentDigest): Promise<HeldContentRef>;
  /** The verified bytes `ref` points at. */
  read(ref: ContentRef): Promise<Uint8Array<ArrayBuffer>>;
  /** Whether a provider of this name is registered, so its references can be recorded and read. */
  hasProvider(name: ContentProviderName): boolean;
}

/** One stored inline text or R2 object, as the content sweep lists it. */
export interface StoredContent {
  key: string;
  /** When it was written, which the sweep's grace period is measured from. */
  storedAt: Date;
}

/** Where inline text is kept, keyed by digest: in production, a table beside the artifact records. */
export interface InlineTextTable {
  /** The text stored under `key`, if any. */
  get(key: string): Promise<string | undefined>;
  /** Stores `text` under `key`. */
  put(key: string, text: string): Promise<void>;
  /** Deletes the text under `key`. Deleting a missing key does nothing. */
  delete(key: string): Promise<void>;
  /** Every stored key, with when it was written. */
  list(): Promise<StoredContent[]>;
}

/** An {@link InlineTextTable} held in memory, for tests and the local harness. */
export class InMemoryInlineTextTable implements InlineTextTable {
  readonly #rows = new Map<string, { text: string; storedAt: Date }>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async get(key: string): Promise<string | undefined> {
    return this.#rows.get(key)?.text;
  }

  async put(key: string, text: string): Promise<void> {
    this.#rows.set(key, { text, storedAt: this.#now() });
  }

  async delete(key: string): Promise<void> {
    this.#rows.delete(key);
  }

  async list(): Promise<StoredContent[]> {
    return [...this.#rows].map(([key, row]) => ({ key, storedAt: row.storedAt }));
  }
}

/** One page of an R2 listing: the shape of a Workers `R2Objects`, as far as the sweep reads it. */
export interface R2ListPage {
  objects: { key: string; uploaded: Date }[];
  /** Whether more objects follow, from `cursor`. */
  truncated: boolean;
  cursor?: string;
}

/**
 * The part of an R2 bucket the artifact store uses. A Workers `R2Bucket` satisfies it. Only the
 * content sweep deletes or lists, and it deletes only content no revision references.
 */
export interface R2BucketLike {
  /** Stores an object. With `sha256`, R2 refuses an upload whose bytes do not match. */
  put(key: string, value: Uint8Array<ArrayBuffer>, options?: { sha256?: string }): Promise<unknown>;
  /** The object under `key`, or null. */
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  /** The object's metadata, or null. */
  head(key: string): Promise<{ size: number } | null>;
  /** Deletes the object under `key`. Deleting a missing key does nothing. */
  delete(key: string): Promise<void>;
  /** One page of the objects whose keys start with `prefix`, from `cursor`. */
  list(options?: { prefix?: string; cursor?: string }): Promise<R2ListPage>;
}

/** An {@link R2BucketLike} held in memory, for tests and the local harness. Lists two objects a page. */
export class InMemoryR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; uploaded: Date }>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async put(key: string, value: Uint8Array<ArrayBuffer>, options: { sha256?: string } = {}): Promise<unknown> {
    if (options.sha256 !== undefined && digestHex(await sha256Digest(value)) !== options.sha256) {
      throw new Error(`put ${key}: the bytes do not match the sha256 checksum`);
    }
    this.#objects.set(key, { bytes: value.slice(), uploaded: this.#now() });
    return { key, size: value.byteLength };
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const object = this.#objects.get(key);
    if (object === undefined) return null;
    return { arrayBuffer: async () => object.bytes.slice().buffer };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const object = this.#objects.get(key);
    return object === undefined ? null : { size: object.bytes.byteLength };
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }

  async list(options: { prefix?: string; cursor?: string } = {}): Promise<R2ListPage> {
    const keys = [...this.#objects.keys()].filter((k) => k.startsWith(options.prefix ?? "")).toSorted();
    const start = options.cursor === undefined ? 0 : Number(options.cursor);
    const page = keys.slice(start, start + 2);
    const objects = page.map((key) => ({ key, uploaded: this.#objects.get(key)!.uploaded }));
    const next = start + page.length;
    return next < keys.length ? { objects, truncated: true, cursor: String(next) } : { objects, truncated: false };
  }
}

/** The prefix every R2 content key starts with. */
export const R2_CONTENT_PREFIX = "sha256/";

/** The key content with `digest` is held under in `backend`: the digest's hex, prefixed in R2. */
export function heldKey(backend: HeldContentRef["backend"], digest: ContentDigest): string {
  return backend === "text" ? digestHex(digest) : `${R2_CONTENT_PREFIX}${digestHex(digest)}`;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The {@link ArtifactStore} over an inline text table, an R2 bucket and any registered providers. */
export class BackendArtifactStore implements ArtifactStore {
  readonly #text: InlineTextTable;
  readonly #r2: R2BucketLike;
  readonly #providers: ReadonlyMap<string, ContentProvider>;

  constructor(backends: { text: InlineTextTable; r2: R2BucketLike; providers?: readonly ContentProvider[] }) {
    this.#text = backends.text;
    this.#r2 = backends.r2;
    this.#providers = new Map((backends.providers ?? []).map((p) => [p.name, p]));
  }

  hasProvider(name: ContentProviderName): boolean {
    return this.#providers.has(name);
  }

  async write(backend: HeldContentRef["backend"], bytes: Uint8Array<ArrayBuffer>, digest: ContentDigest): Promise<HeldContentRef> {
    const key = heldKey(backend, digest);
    if (backend === "text") {
      if (bytes.byteLength > INLINE_TEXT_LIMIT_BYTES) throw new Error("inline text exceeds the size limit");
      if ((await this.#text.get(key)) === undefined) await this.#text.put(key, decoder.decode(bytes));
      return { backend, key, digest };
    }
    if ((await this.#r2.head(key)) === null) await this.#r2.put(key, bytes, { sha256: digestHex(digest) });
    return { backend, key, digest };
  }

  async read(ref: ContentRef): Promise<Uint8Array<ArrayBuffer>> {
    if (ref.backend === "external") {
      throw new SchoolOsError("unavailable", "This is a link to an external document; SchoolOS does not hold its content.");
    }
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    if (ref.backend === "text") {
      const text = await this.#text.get(ref.key);
      if (text !== undefined) bytes = encoder.encode(text);
    } else if (ref.backend === "registered") {
      const provider = this.#providers.get(ref.provider);
      if (provider === undefined) throw new SchoolOsError("unavailable", "This content's storage is not available here.");
      bytes = (await provider.read(ref)) ?? undefined;
    } else {
      const object = await this.#r2.get(ref.key);
      if (object !== null) bytes = new Uint8Array(await object.arrayBuffer());
    }
    if (bytes === undefined) throw new SchoolOsError("unavailable", "This content is missing from storage.");
    if ((await sha256Digest(bytes)) !== ref.digest) {
      throw new SchoolOsError("unavailable", "This content failed its integrity check and cannot be shown.");
    }
    return bytes;
  }
}
