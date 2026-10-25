import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";

/** Unpadded base64url text, the encoding of every key, signature and token on the wire. */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, "expected unpadded base64url");

/** Encodes bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // In chunks, since a transfer archive (`@educateos/portability`) can run to tens of megabytes.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes unpadded base64url, throwing `validation-failed` on anything else. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!Base64Url.safeParse(text).success || text.length % 4 === 1) {
    throw new EducateOsError("validation-failed", "malformed base64url");
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Serializes a JSON value with object keys sorted and no whitespace, so a signer and a verifier
 * that hold the same value produce the same bytes regardless of how the value travelled. Object
 * properties whose value is `undefined` are omitted, as `JSON.stringify` omits them. Anything that
 * JSON cannot represent exactly (non-finite numbers, `undefined` in an array, class instances such
 * as `Date`) is rejected rather than coerced, because a silent coercion would let two different
 * values share a signature.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EducateOsError("validation-failed", "non-finite number in signed payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined) throw new EducateOsError("validation-failed", "undefined in signed array");
      return canonicalJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EducateOsError("validation-failed", "signed payloads must be plain JSON objects");
    }
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new EducateOsError("validation-failed", `cannot sign a ${typeof value}`);
}
