/** The namespace for name-based (version 5) UUIDs the catalog mints. Fixed: changing it renames every record. */
const CATALOG_UUID_NAMESPACE = "e1247ede-d30c-4765-bd99-4db994309b6e";

/**
 * JSON with object keys sorted, so equal values serialize identically whatever their key order.
 * Digests and diffs are computed over this form.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The `sha256:<hex>` digest of a value's canonical JSON. */
export async function contentDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
}

/**
 * A name-based UUID (RFC 9562 version 5) in the catalog's namespace. The same name always yields
 * the same identifier, so a regenerated release keeps its records' identities.
 */
export async function catalogUuid(name: string): Promise<string> {
  const namespace = Uint8Array.from(CATALOG_UUID_NAMESPACE.replaceAll("-", "").match(/../g)!, (h) => Number.parseInt(h, 16));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + nameBytes.length);
  input.set(namespace);
  input.set(nameBytes, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
