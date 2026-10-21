import { z } from "zod";
import { Base64Url, fromBase64Url, toBase64Url } from "./encoding.ts";

const ED25519 = { name: "Ed25519" } as const;

/** A raw 32-byte Ed25519 public key, base64url-encoded. */
export const Ed25519PublicKey = Base64Url.length(43).brand<"ed25519PublicKey">();
/** An Ed25519 public key. */
export type Ed25519PublicKey = z.infer<typeof Ed25519PublicKey>;

/**
 * Names a public key: `ed25519-` and the base64url SHA-256 of its raw bytes. Because it is derived
 * from the key, a key ID can never be pointed at a different key.
 */
export const KeyId = z
  .string()
  .regex(/^ed25519-[A-Za-z0-9_-]{43}$/, "expected an Ed25519 key ID")
  .brand<"keyId">();
/** A key identifier. */
export type KeyId = z.infer<typeof KeyId>;

/** An Ed25519 private key as a JWK. It carries the public key too (`x`), so one secret restores the identity. */
export const Ed25519PrivateJwk = z.strictObject({
  kty: z.literal("OKP"),
  crv: z.literal("Ed25519"),
  x: Base64Url.length(43),
  d: Base64Url.length(43),
});
/** An Ed25519 private JWK. */
export type Ed25519PrivateJwk = z.infer<typeof Ed25519PrivateJwk>;

/** A 64-byte Ed25519 signature, base64url-encoded. */
export const Ed25519Signature = Base64Url.length(86);

/** Derives the {@link KeyId} of a public key. */
export async function keyIdFor(publicKey: Ed25519PublicKey): Promise<KeyId> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey));
  return KeyId.parse(`ed25519-${toBase64Url(new Uint8Array(digest))}`);
}

/**
 * Verifies an Ed25519 signature. Returns false, never throws, for a malformed key or signature, so
 * every bad input takes the same rejection path.
 */
export async function verifySignature(
  publicKey: Ed25519PublicKey,
  signature: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64Url(publicKey), ED25519, false, ["verify"]);
    return await crypto.subtle.verify(ED25519, key, fromBase64Url(signature), data);
  } catch {
    return false;
  }
}

/**
 * An Ed25519 key pair held through Web Crypto: a district agent's identity, or the root's signing
 * key. The private key never leaves the object except through {@link SigningIdentity.exportJwk},
 * which exists so the holder can persist it as a secret.
 */
export class SigningIdentity {
  /** The ID of {@link SigningIdentity.publicKey}. */
  readonly keyId: KeyId;
  /** The public key, to register with whoever verifies this identity's signatures. */
  readonly publicKey: Ed25519PublicKey;
  readonly #privateKey: CryptoKey;

  private constructor(keyId: KeyId, publicKey: Ed25519PublicKey, privateKey: CryptoKey) {
    this.keyId = keyId;
    this.publicKey = publicKey;
    this.#privateKey = privateKey;
  }

  /** Generates a new identity. The private key is extractable only so it can be persisted. */
  static async generate(): Promise<SigningIdentity> {
    const pair = await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"]);
    // Web Crypto's typings can't tell from the algorithm that Ed25519 yields a pair.
    if (!("privateKey" in pair)) throw new Error("Ed25519 key generation returned a single key");
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const publicKey = Ed25519PublicKey.parse(toBase64Url(raw));
    return new SigningIdentity(await keyIdFor(publicKey), publicKey, pair.privateKey);
  }

  /** Restores an identity persisted with {@link SigningIdentity.exportJwk}. */
  static async fromJwk(input: Ed25519PrivateJwk): Promise<SigningIdentity> {
    const jwk = Ed25519PrivateJwk.parse(input);
    const privateKey = await crypto.subtle.importKey("jwk", jwk, ED25519, true, ["sign"]);
    const publicKey = Ed25519PublicKey.parse(jwk.x);
    return new SigningIdentity(await keyIdFor(publicKey), publicKey, privateKey);
  }

  /** Exports the private key as a JWK (which also carries the public key) for secret storage. */
  async exportJwk(): Promise<Ed25519PrivateJwk> {
    const jwk = await crypto.subtle.exportKey("jwk", this.#privateKey);
    return Ed25519PrivateJwk.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, d: jwk.d });
  }

  /** Signs bytes, returning the base64url signature. */
  async sign(data: Uint8Array<ArrayBuffer>): Promise<string> {
    return toBase64Url(new Uint8Array(await crypto.subtle.sign(ED25519, this.#privateKey, data)));
  }
}
