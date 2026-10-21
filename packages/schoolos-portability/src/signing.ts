import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { canonicalJsonBytes } from "./archive.ts";

/**
 * Ed25519 signing for transfer packages, through Web Crypto.
 *
 * This mirrors `@schoolos/fleet`'s `SigningIdentity`, `KeyId` and `SignedEnvelope` byte for byte in
 * shape: the same key ID derivation, the same envelope fields, and a context string and message
 * kind in the signed bytes. It is defined here because `@schoolos/fleet` is not among this
 * package's dependencies on its branch. Once both are merged it should be replaced by the fleet
 * module, with `student-transfer` added to `FleetMessageKind`. Only the signing code is shared
 * that way: a transfer never travels through the root (ADR-0001).
 */

/** Unpadded base64url text. */
export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, "expected unpadded base64url");

/** Encodes bytes as unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decodes unpadded base64url, throwing `validation-failed` on anything else. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!Base64Url.safeParse(text).success || text.length % 4 === 1) {
    throw new SchoolOsError("validation-failed", "malformed base64url");
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const ED25519 = { name: "Ed25519" } as const;

/** A raw 32-byte Ed25519 public key, base64url-encoded. */
export const Ed25519PublicKey = Base64Url.length(43).brand<"ed25519PublicKey">();
/** An Ed25519 public key. */
export type Ed25519PublicKey = z.infer<typeof Ed25519PublicKey>;

/** Names a public key: `ed25519-` and the base64url SHA-256 of its raw bytes, so it can never name another key. */
export const KeyId = z.string().regex(/^ed25519-[A-Za-z0-9_-]{43}$/, "expected an Ed25519 key ID").brand<"keyId">();
/** A key identifier. */
export type KeyId = z.infer<typeof KeyId>;

/** Derives the {@link KeyId} of a public key. */
export async function keyIdFor(publicKey: Ed25519PublicKey): Promise<KeyId> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey));
  return KeyId.parse(`ed25519-${toBase64Url(new Uint8Array(digest))}`);
}

/** A district agent's Ed25519 key pair. The private key never leaves the object. */
export class SigningIdentity {
  /** The ID of {@link SigningIdentity.publicKey}. */
  readonly keyId: KeyId;
  /** The public key, which a receiving district's admin pins. */
  readonly publicKey: Ed25519PublicKey;
  readonly #privateKey: CryptoKey;

  private constructor(keyId: KeyId, publicKey: Ed25519PublicKey, privateKey: CryptoKey) {
    this.keyId = keyId;
    this.publicKey = publicKey;
    this.#privateKey = privateKey;
  }

  /** Generates a new, non-extractable identity. */
  static async generate(): Promise<SigningIdentity> {
    const pair = await crypto.subtle.generateKey(ED25519, false, ["sign", "verify"]);
    // Web Crypto's typings can't tell from the algorithm that Ed25519 yields a pair.
    if (!("privateKey" in pair)) throw new Error("Ed25519 key generation returned a single key");
    const publicKey = Ed25519PublicKey.parse(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))));
    return new SigningIdentity(await keyIdFor(publicKey), publicKey, pair.privateKey);
  }

  /** Signs bytes, returning the base64url signature. */
  async sign(data: Uint8Array<ArrayBuffer>): Promise<string> {
    return toBase64Url(new Uint8Array(await crypto.subtle.sign(ED25519, this.#privateKey, data)));
  }
}

/**
 * A signed message. `signature` covers a context string, the message kind and the canonical JSON
 * of `payload`, so a signature made for one kind never verifies as another. Verifiers look the key
 * up themselves from `keyId` and never trust a key carried alongside the signature.
 */
export const SignedEnvelope = z.strictObject({
  payload: z.json(),
  signature: Base64Url.length(86),
  keyId: KeyId,
});
/** A signed envelope. */
export type SignedEnvelope = z.infer<typeof SignedEnvelope>;

/** The kinds of message signed with these envelopes. */
export type SignedMessageKind = "student-transfer";

const CONTEXT = "schoolos-transfer/v1";
const encoder = new TextEncoder();

function signedBytes(kind: SignedMessageKind, payload: unknown): Uint8Array<ArrayBuffer> {
  const json = new TextDecoder().decode(canonicalJsonBytes(payload));
  return encoder.encode(`${CONTEXT}\0${kind}\0${json}`);
}

/** Signs `payload` as a message of `kind`. The envelope carries the canonical payload that was signed. */
export async function signEnvelope(identity: SigningIdentity, kind: SignedMessageKind, payload: unknown): Promise<SignedEnvelope> {
  const bytes = signedBytes(kind, payload);
  return { payload: JSON.parse(new TextDecoder().decode(canonicalJsonBytes(payload))), signature: await identity.sign(bytes), keyId: identity.keyId };
}

/**
 * Whether the envelope is a message of `kind` signed by `publicKey`, whose ID it must name. Returns
 * false, never throws, for any malformed key, signature or payload.
 */
export async function verifyEnvelope(envelope: SignedEnvelope, kind: SignedMessageKind, publicKey: Ed25519PublicKey): Promise<boolean> {
  try {
    if (envelope.keyId !== (await keyIdFor(publicKey))) return false;
    const key = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, fromBase64Url(envelope.signature), signedBytes(kind, envelope.payload));
  } catch {
    return false;
  }
}
