/** The hex SHA-256 of bytes or of a string's UTF-8 encoding. */
export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * JSON with object keys sorted at every depth, so equal values always serialize to equal strings.
 * Same contract as `stableStringify` in scripts/release/hash-lib.ts.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).toSorted().map((key) => [key, sortKeysDeep(record[key])]));
  }
  return value;
}
