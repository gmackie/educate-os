import { z } from "zod";

/**
 * Identifies one content item: one imported revision of a source as it moves through the ingest
 * pipeline. It follows the `<prefix>_<body>` convention of `@schoolos/contracts`, and may belong
 * there once another package needs it.
 */
export const ContentItemId = z
  .string()
  .regex(/^cit_[a-z0-9][a-z0-9-]{0,62}$/, "expected a content item ID (cit_…)")
  .brand<"contentItem">();
/** A content item identifier. */
export type ContentItemId = z.infer<typeof ContentItemId>;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The `sha256:<hex>` digest of raw bytes: the snapshot hash an item and its release keep. */
export async function snapshotDigest(bytes: Uint8Array): Promise<string> {
  // WebCrypto takes only views over an `ArrayBuffer`, so a view over shared memory is copied first.
  const owned = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes.slice();
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned)))}`;
}

/** A fresh random identifier body: 32 lowercase hex digits. */
export function randomIdBody(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
