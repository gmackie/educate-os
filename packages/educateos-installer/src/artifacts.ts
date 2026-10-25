import { EducateOsError } from "@educateos/contracts";
import { sha256Hex } from "./digest.ts";

/**
 * Where a release's content-addressed blobs come from: worker modules and D1 migration SQL by
 * SHA-256, static assets by their Workers content key.
 */
export interface ReleaseArtifacts {
  /** The bytes stored under a SHA-256. */
  blob(sha256: string): Promise<Uint8Array<ArrayBuffer>>;
  /** The bytes of a static asset, by its 32-hex-digit Workers content key. */
  asset(hash: string): Promise<Uint8Array<ArrayBuffer>>;
}

/**
 * Reads a blob and checks it against its manifest SHA-256 and size, so a corrupted or substituted
 * blob is never uploaded. Asset content keys are BLAKE3-derived, which Web Crypto lacks; assets
 * are checked by size, and Cloudflare recomputes their keys on upload.
 */
export async function verifiedBlob(artifacts: ReleaseArtifacts, sha256: string, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await artifacts.blob(sha256);
  if (bytes.byteLength !== size || (await sha256Hex(bytes)) !== sha256) {
    throw new EducateOsError("validation-failed", `release blob ${sha256} does not match its manifest digest`);
  }
  return bytes;
}

/** An asset, checked against its manifest size. */
export async function verifiedAsset(artifacts: ReleaseArtifacts, hash: string, size: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await artifacts.asset(hash);
  if (bytes.byteLength !== size) throw new EducateOsError("validation-failed", `release asset ${hash} has the wrong size`);
  return bytes;
}

/** {@link ReleaseArtifacts} held in memory. For tests and the harness. */
export class InMemoryReleaseArtifacts implements ReleaseArtifacts {
  readonly #blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly #assets = new Map<string, Uint8Array<ArrayBuffer>>();

  /** Stores a blob under its SHA-256 and returns the digest. */
  async addBlob(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const sha256 = await sha256Hex(bytes);
    this.#blobs.set(sha256, bytes);
    return sha256;
  }

  /** Stores an asset under a content key. */
  addAsset(hash: string, bytes: Uint8Array<ArrayBuffer>): void {
    this.#assets.set(hash, bytes);
  }

  async blob(sha256: string) {
    const bytes = this.#blobs.get(sha256);
    if (!bytes) throw new EducateOsError("not-found", `release blob ${sha256} is missing`);
    return bytes;
  }

  async asset(hash: string) {
    const bytes = this.#assets.get(hash);
    if (!bytes) throw new EducateOsError("not-found", `release asset ${hash} is missing`);
    return bytes;
  }
}
