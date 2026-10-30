import { AssessmentDefinition, Digest } from "./contracts.ts";

/**
 * v1 canonical JSON: plain JSON only, sorted UTF-16 object keys, significant array order and
 * strings, finite numbers, JSON number spelling. No Unicode/text normalization is implicit.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) throw new Error("Expected acyclic JSON");
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new Error("Expected dense JSON array");
        return `[${Array.from(item, visit).join(",")}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Expected plain JSON object");
      if (Reflect.ownKeys(item).some((key) => typeof key !== "string")) throw new Error("Expected JSON keys");
      return `{${Object.keys(item).toSorted().map((key) => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { seen.delete(item); }
  };
  return visit(value);
}
/** Hash exact bytes using Web Crypto (Node 24, browsers, Workers); no platform dependency. */
export async function digestBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
/** Hash a JSON value under the v1 canonicalization rules. */
export async function digestJson(value: unknown): Promise<string> {
  return digestBytes(new TextEncoder().encode(canonicalJson(value)));
}
/** Recursively freeze a parsed JSON snapshot. */
export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
/** Parse first, then pin the public definition. Returned snapshots cannot mutate under a digest. */
export async function releaseAssessment(raw: unknown) {
  const definition = AssessmentDefinition.parse(raw);
  return freezeJson({ definition, digest: await digestJson(definition) });
}
/** Strictly verify an externally supplied definition against an immutable pin. */
export async function verifyAssessment(raw: unknown, expectedDigest: unknown) {
  const release = await releaseAssessment(raw);
  if (release.digest !== Digest.parse(expectedDigest)) throw new Error("Assessment release digest mismatch");
  return release;
}
