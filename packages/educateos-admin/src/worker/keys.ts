// The admin's ops signing keys at rest (SCHO-263). Each workspace has its own Ed25519 key pair; the
// private half is stored in D1 encrypted with AES-256-GCM under the ADMIN_KEY_ENCRYPTION_KEY secret
// (32 random bytes, base64url). The workspace and key ID are the additional data, so a ciphertext
// copied onto another workspace's row fails to decrypt instead of signing for it.
import { Ed25519PrivateJwk, SigningIdentity } from "@educateos/fleet/ops";
import { fromBase64Url, toBase64Url } from "@educateos/fleet";

const FORMAT = "v1";

/** The encryption key is missing or malformed. */
export class KeyEncryptionError extends Error {
  override readonly name = "KeyEncryptionError";
}

/** Imports ADMIN_KEY_ENCRYPTION_KEY. */
export async function importKeyEncryptionKey(secret: string | undefined): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64Url((secret ?? "").trim());
  } catch {
    throw new KeyEncryptionError("ADMIN_KEY_ENCRYPTION_KEY is not base64url");
  }
  if (raw.byteLength !== 32) throw new KeyEncryptionError("ADMIN_KEY_ENCRYPTION_KEY must be 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function additionalData(workspaceId: string, keyId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`educateos-admin/ops-key/${FORMAT}\n${workspaceId}\n${keyId}`).slice();
}

/** Encrypts a private JWK for one workspace's row. */
export async function sealPrivateKey(kek: CryptoKey, workspaceId: string, identity: SigningIdentity): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(await identity.exportJwk())).slice();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(workspaceId, identity.keyId) },
    kek,
    plaintext,
  );
  return `${FORMAT}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypts a row's private key back into a signing identity. Throws if it was tampered with or moved. */
export async function openPrivateKey(kek: CryptoKey, workspaceId: string, keyId: string, sealed: string): Promise<SigningIdentity> {
  const [format, iv, ciphertext] = sealed.split(".");
  if (format !== FORMAT || iv === undefined || ciphertext === undefined) throw new KeyEncryptionError("unrecognised sealed key");
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: additionalData(workspaceId, keyId) },
      kek,
      fromBase64Url(ciphertext),
    );
  } catch {
    throw new KeyEncryptionError("the sealed key did not decrypt");
  }
  const identity = await SigningIdentity.fromJwk(Ed25519PrivateJwk.parse(JSON.parse(new TextDecoder().decode(plaintext))));
  if (identity.keyId !== keyId) throw new KeyEncryptionError("the sealed key is not the key its row names");
  return identity;
}
