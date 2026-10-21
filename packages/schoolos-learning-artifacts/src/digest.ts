import { ContentDigest } from "@schoolos/contracts";

const encoder = new TextEncoder();

/**
 * The canonical bytes of a text revision: UTF-8, Unicode NFC, `\n` line endings and no byte-order
 * mark. Saving the same essay from Windows, macOS or a phone therefore gives the same bytes and
 * the same digest. Binary content is never canonicalized; its bytes are its canonical form.
 */
export function canonicalTextBytes(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text.replace(/^\uFEFF/, "").normalize("NFC").replace(/\r\n?/g, "\n"));
}

/** The SHA-256 digest of `bytes`. */
export async function sha256Digest(bytes: Uint8Array<ArrayBuffer>): Promise<ContentDigest> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return ContentDigest.parse(`sha256:${Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")}`);
}

/** The hex part of a digest, as backends use it in keys. */
export function digestHex(digest: ContentDigest): string {
  return digest.slice("sha256:".length);
}
