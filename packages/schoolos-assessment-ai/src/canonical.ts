// Canonical JSON digests, as `@schoolos/assessment-ci` takes them (its `canonical.ts`, which that
// package does not export).
import { sha256Digest, type ContentDigest } from "@schoolos/learning-artifacts";

const encoder = new TextEncoder();

/** JSON with object keys sorted at every level and no whitespace, so equal values give equal bytes. */
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
