// A OneRoster bulk export uploaded as one ZIP, read through the shared bounded reader. New for
// EducateOS.
import { readZip, type ZipLimits } from "@educateos/zip";
import { DEFAULT_CSV_LIMITS, type OneRosterCsvFiles } from "./feed.ts";
import { ONEROSTER_FILES } from "./spec.ts";

/** The files a ZIP export is read for. Nothing else in the archive is ever inflated. */
const EXPORT_FILES: ReadonlySet<string> = new Set(["manifest.csv", ...ONEROSTER_FILES]);

/**
 * Limits for an uploaded export. One file may be as large as the CSV path accepts, and the files
 * EducateOS reads together a few times that.
 */
export const DEFAULT_ONEROSTER_ZIP_LIMITS: ZipLimits = {
  maxEntries: 64,
  maxEntryBytes: DEFAULT_CSV_LIMITS.maxFileBytes,
  maxTotalBytes: 4 * DEFAULT_CSV_LIMITS.maxFileBytes,
  maxCompressionRatio: 100,
};

/**
 * Reads a bulk export uploaded as a ZIP into the files `readOneRosterCsv` and `csvRosterSource`
 * take. Only `manifest.csv` and the files EducateOS reads are extracted, from the archive's root;
 * every other entry is listed but never inflated. `demographics.csv`, the most sensitive file in an
 * export, is therefore never decompressed, and its size counts against no limit.
 *
 * The archive is refused whole (see `@educateos/zip`) on an unsafe entry name anywhere in it, an
 * encrypted, ZIP64 or overlapping entry, more than `limits.maxEntries` entries, or a file it reads
 * that is over the size or compression-ratio caps or does not match its checksum.
 *
 * @throws ZipRefusedError naming the check that refused it.
 */
export async function readOneRosterZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ONEROSTER_ZIP_LIMITS,
): Promise<OneRosterCsvFiles> {
  const archive = await readZip(bytes, limits, { include: (path) => EXPORT_FILES.has(path) });
  return Object.fromEntries(archive.files);
}
