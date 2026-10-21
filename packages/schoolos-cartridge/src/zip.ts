// The bounded reader lives in @schoolos/zip, shared with the OneRoster importer. This module keeps
// the cartridge's limits and reports a refusal as a cartridge refusal, so callers and tests see the
// same `CartridgeRefusedError` reasons as before.
import {
  assertSafePath as assertSafeZipPath,
  readZip as readBoundedZip,
  ZipRefusedError,
  type ZipArchive,
  type ZipLimits,
} from "@schoolos/zip";
import { CartridgeRefusedError } from "./errors.ts";

export { crc32, RATIO_FLOOR_BYTES, type IgnoredZipEntry, type ZipArchive, type ZipLimits } from "@schoolos/zip";

/**
 * Generous for a Thin CC, which holds a manifest and one small XML file per link, and far below
 * what a Worker can hold in memory.
 */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
};

/**
 * Reads a cartridge archive within `limits` (see `@schoolos/zip`'s `readZip`).
 *
 * @throws CartridgeRefusedError naming the check that failed.
 */
export async function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipArchive> {
  try {
    return await readBoundedZip(bytes, limits);
  } catch (error) {
    throw asCartridgeRefusal(error);
  }
}

/**
 * Refuses a path that could name anything outside the archive's own tree (see `@schoolos/zip`).
 *
 * @throws CartridgeRefusedError `unsafe-path`.
 */
export function assertSafePath(path: string): void {
  try {
    assertSafeZipPath(path);
  } catch (error) {
    throw asCartridgeRefusal(error);
  }
}

function asCartridgeRefusal(error: unknown): unknown {
  return error instanceof ZipRefusedError ? new CartridgeRefusedError(error.reason, error.detail) : error;
}
