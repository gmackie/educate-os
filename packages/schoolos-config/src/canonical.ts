/**
 * Encodes a JSON value with object keys sorted at every depth and no insignificant whitespace, so
 * equal values always produce identical text. Keys whose value is `undefined` are dropped, as
 * `JSON.stringify` would. Anything JSON cannot represent faithfully (non-finite numbers, functions,
 * class instances such as `Date` or `Map`) is rejected rather than silently coerced, because a
 * coerced value would make two different states hash alike.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot encode a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode a ${typeof value}`);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The lower-case hex SHA-256 digest of a UTF-8 string, computed with Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The content hash of a JSON value: `sha256:` and the digest of its canonical encoding. */
export async function contentHash(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}
