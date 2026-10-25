import { EducateOsError } from "@educateos/contracts";
import type { ContentType } from "./sniff.ts";

/** A malware scanner's verdict on one upload. */
export type ScanVerdict = { verdict: "clean" } | { verdict: "infected"; signature: string };

/** Scans uploaded bytes for malware. The district supplies one; EducateOS ships none. */
export interface MalwareScanner {
  /** Scans one upload. Throwing is treated as a failed scan, never as clean. */
  scan(bytes: Uint8Array, contentType: ContentType): Promise<ScanVerdict>;
}

/**
 * The district's scanner setting. `"none"` skips scanning and must be set explicitly, for pilots;
 * leaving it unset refuses every upload rather than accepting unscanned files by default.
 */
export type ScannerSetting = MalwareScanner | "none" | undefined;

/** The outcome of scanning an upload, recorded on the item. */
export type ScanOutcome = { verdict: "clean" } | { verdict: "infected"; signature: string } | { verdict: "skipped" };

/**
 * Scans an upload under the district's setting.
 *
 * @throws EducateOsError `unavailable` when no scanner is configured, or when the scanner fails.
 */
export async function scanUpload(setting: ScannerSetting, bytes: Uint8Array, contentType: ContentType): Promise<ScanOutcome> {
  if (setting === undefined) throw new EducateOsError("unavailable", "scanner not configured");
  if (setting === "none") return { verdict: "skipped" };
  let verdict: ScanVerdict;
  try {
    verdict = await setting.scan(bytes, contentType);
  } catch {
    throw new EducateOsError("unavailable", "the malware scan failed");
  }
  // Anything but an explicit clean verdict counts as infected, so a malformed answer fails closed.
  if (verdict?.verdict === "clean") return { verdict: "clean" };
  const signature = verdict?.verdict === "infected" && typeof verdict.signature === "string" ? verdict.signature.slice(0, 200) : "unrecognized scanner verdict";
  return { verdict: "infected", signature };
}
