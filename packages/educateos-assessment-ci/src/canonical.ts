import type { ContentDigest } from "@educateos/contracts";
import { sha256Digest } from "@educateos/learning-artifacts";

const encoder = new TextEncoder();

/**
 * JSON with object keys sorted at every level and no whitespace, so equal values always give equal
 * bytes. Digests of rubric releases, evaluator sets and run keys are taken over it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).toSorted().map((k) => [k, record[k]]));
  });
}

/** The SHA-256 digest of {@link canonicalJson} of `value`. */
export async function canonicalDigest(value: unknown): Promise<ContentDigest> {
  return sha256Digest(encoder.encode(canonicalJson(value)));
}
