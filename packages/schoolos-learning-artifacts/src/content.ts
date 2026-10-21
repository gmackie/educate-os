import { SchoolOsError, type ArtifactType, type ContentDigest } from "@schoolos/contracts";
import { digestHex, sha256Digest } from "./digest.ts";
import type { ContentBackendKind, ContentRef, HeldContentRef, MediaType } from "./model.ts";

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
 * Where a revision's content goes. Pure: the same type, media type and size always choose the same
 * backend. An `external-ref` is never held; small text is kept inline; everything else, including
 * every image, recording and video, is an R2 object.
 */
export function chooseBackend(input: { type: ArtifactType; mediaType: MediaType; sizeBytes: number }): ContentBackendKind {
  if (input.type === "external-ref") return "external";
  if (MEDIA_TYPES.includes(input.type)) return "r2";
  return isTextMediaType(input.mediaType) && input.sizeBytes <= INLINE_TEXT_LIMIT_BYTES ? "text" : "r2";
}

/**
 * Holds revision content by digest. Writes are idempotent, since a key names its content; every
 * read verifies the bytes against the reference's digest and answers `unavailable` if they differ.
 * An external reference is never read: SchoolOS does not hold its content.
 */
export interface ArtifactStore {
  /** Stores `bytes`, whose digest the caller computed, in `backend`, and returns the reference. */
  write(backend: HeldContentRef["backend"], bytes: Uint8Array<ArrayBuffer>, digest: ContentDigest): Promise<HeldContentRef>;
  /** The verified bytes `ref` points at. */
  read(ref: ContentRef): Promise<Uint8Array<ArrayBuffer>>;
}

/** Where inline text is kept, keyed by digest: in production, a table beside the artifact records. */
export interface InlineTextTable {
  /** The text stored under `key`, if any. */
  get(key: string): Promise<string | undefined>;
  /** Stores `text` under `key`. */
  put(key: string, text: string): Promise<void>;
}

/** An {@link InlineTextTable} held in memory, for tests and the local harness. */
export class InMemoryInlineTextTable implements InlineTextTable {
  readonly #rows = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.#rows.get(key);
  }

  async put(key: string, text: string): Promise<void> {
    this.#rows.set(key, text);
  }
}

/**
 * The part of an R2 bucket the artifact store uses. A Workers `R2Bucket` satisfies it. There is
 * deliberately no delete: content is removed only by a retention job that knows nothing pins it.
 */
export interface R2BucketLike {
  /** Stores an object. With `sha256`, R2 refuses an upload whose bytes do not match. */
  put(key: string, value: Uint8Array<ArrayBuffer>, options?: { sha256?: string }): Promise<unknown>;
  /** The object under `key`, or null. */
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  /** The object's metadata, or null. */
  head(key: string): Promise<{ size: number } | null>;
}

/** An {@link R2BucketLike} held in memory, for tests and the local harness. */
export class InMemoryR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, Uint8Array<ArrayBuffer>>();

  async put(key: string, value: Uint8Array<ArrayBuffer>, options: { sha256?: string } = {}): Promise<unknown> {
    if (options.sha256 !== undefined && digestHex(await sha256Digest(value)) !== options.sha256) {
      throw new Error(`put ${key}: the bytes do not match the sha256 checksum`);
    }
    this.#objects.set(key, value.slice());
    return { key, size: value.byteLength };
  }

  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const bytes = this.#objects.get(key);
    if (bytes === undefined) return null;
    return { arrayBuffer: async () => bytes.slice().buffer };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const bytes = this.#objects.get(key);
    return bytes === undefined ? null : { size: bytes.byteLength };
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The {@link ArtifactStore} over an inline text table and an R2 bucket. */
export class BackendArtifactStore implements ArtifactStore {
  readonly #text: InlineTextTable;
  readonly #r2: R2BucketLike;

  constructor(backends: { text: InlineTextTable; r2: R2BucketLike }) {
    this.#text = backends.text;
    this.#r2 = backends.r2;
  }

  async write(backend: HeldContentRef["backend"], bytes: Uint8Array<ArrayBuffer>, digest: ContentDigest): Promise<HeldContentRef> {
    const hex = digestHex(digest);
    if (backend === "text") {
      if (bytes.byteLength > INLINE_TEXT_LIMIT_BYTES) throw new Error("inline text exceeds the size limit");
      const key = hex;
      if ((await this.#text.get(key)) === undefined) await this.#text.put(key, decoder.decode(bytes));
      return { backend, key, digest };
    }
    const key = `sha256/${hex}`;
    if ((await this.#r2.head(key)) === null) await this.#r2.put(key, bytes, { sha256: hex });
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
