// Deterministic vendor identifiers derived from seed IDs. Vendors mint their own IDs (Clever a
// 24-hex-digit ObjectId, Google a long decimal), and a client that validates their shape must see
// that shape. Deriving them by hash keeps them stable across runs and across fakes, so a demo
// district's Clever student and its Classroom student are the same person every time.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** 64-bit FNV-1a of `text`, seeded so that two namespaces never share an ID. */
function fnv1a(text: string, seed = FNV_OFFSET): bigint {
  let hash = seed;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** `length` hex digits derived from `namespace` and `id`, such as a Clever ObjectId (24 digits). */
export function hexId(namespace: string, id: string, length = 24): string {
  let out = "";
  for (let round = 0; out.length < length; round++) {
    out += fnv1a(`${namespace}\u0000${id}\u0000${round}`).toString(16).padStart(16, "0");
  }
  return out.slice(0, length);
}

/** A decimal ID of `digits` digits that never starts with 0, such as a Google Classroom ID. */
export function numericId(namespace: string, id: string, digits = 12): string {
  let out = "";
  for (let round = 0; out.length < digits; round++) {
    out += fnv1a(`${namespace}\u0000${id}\u0000${round}`).toString(10).padStart(20, "0");
  }
  return `${1 + (Number(out[0]) % 9)}${out.slice(1, digits)}`;
}

/** An opaque URL-safe token of `length` characters derived from `id`, such as a submission ID. */
export function tokenId(namespace: string, id: string, length = 16): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let round = 0; out.length < length; round++) {
    let hash = fnv1a(`${namespace}\u0000${id}\u0000${round}`);
    for (let i = 0; i < 10 && out.length < length; i++) {
      out += alphabet[Number(hash & 63n)];
      hash >>= 6n;
    }
  }
  return out;
}
