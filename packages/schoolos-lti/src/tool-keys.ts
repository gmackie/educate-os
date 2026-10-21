// Extracted from PlayTrek `packages/lti/src/jwks/keys.ts` at commit 7258e4347. PlayTrek generated
// and exported PEM keys through `jose`; this version stores private keys as JWKs and uses Web
// Crypto directly, and adds rotation: a key set keeps publishing retired public keys so platforms
// can still verify messages signed just before a rotation.
import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { randomToken } from "./stores.ts";

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * A tool signing key as it is kept in a secret store: the RSA private key as a JWK, with its key
 * ID. This is a secret. It never appears in the tool JWKS or in a log.
 */
export const StoredToolKey = z.strictObject({
  kid: z.string().min(1).max(128),
  privateJwk: z
    .object({ kty: z.literal("RSA"), n: z.string(), e: z.string(), d: z.string(), p: z.string(), q: z.string() })
    .loose(),
});
/** A stored tool key. */
export type StoredToolKey = z.infer<typeof StoredToolKey>;

/** A public key the tool publishes, as it appears in the tool JWKS. */
export interface ToolPublicJwk {
  readonly kty: "RSA";
  readonly kid: string;
  readonly alg: "RS256";
  readonly use: "sig";
  readonly n: string;
  readonly e: string;
}

/** A tool signing key ready to sign: a non-extractable private key and its public JWK. */
export interface ToolKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: ToolPublicJwk;
}

/**
 * The tool's keys: the one it signs with, and retired keys whose public halves it still publishes.
 * Build it with {@link createToolKeySet} and rotate it with {@link rotateToolKeys}.
 */
export interface ToolKeySet {
  readonly signing: ToolKey;
  readonly retired: readonly ToolKey[];
}

/** Generates a new 2048-bit RS256 tool key, returned in its storable form. */
export async function generateToolKey(): Promise<StoredToolKey> {
  const pair = await crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return StoredToolKey.parse({ kid: randomToken().slice(0, 22), privateJwk });
}

/** Imports a stored key for signing. The imported private key is not extractable. */
export async function importToolKey(stored: StoredToolKey): Promise<ToolKey> {
  const { kid, privateJwk } = StoredToolKey.parse(stored);
  const privateKey = await crypto.subtle.importKey("jwk", { ...privateJwk, alg: "RS256" }, RS256, false, ["sign"]);
  return { kid, privateKey, publicJwk: { kty: "RSA", kid, alg: "RS256", use: "sig", n: privateJwk.n, e: privateJwk.e } };
}

/** A key set that signs with `signing` and still publishes `retired`. Key IDs must be unique. */
export function createToolKeySet(signing: ToolKey, retired: readonly ToolKey[] = []): ToolKeySet {
  const kids = [signing, ...retired].map((key) => key.kid);
  if (new Set(kids).size !== kids.length) throw new SchoolOsError("conflict", "Tool key IDs must be unique.");
  return { signing, retired };
}

/**
 * Rotates to `next`: it signs from now on, the previous signing key is retired, and only the
 * `keepRetired` most recently retired keys stay published.
 */
export function rotateToolKeys(set: ToolKeySet, next: ToolKey, keepRetired = 1): ToolKeySet {
  return createToolKeySet(next, [set.signing, ...set.retired].slice(0, keepRetired));
}

/** The tool JWKS document: the public halves of the signing key and every retired key. */
export function toolJwks(set: ToolKeySet): { keys: ToolPublicJwk[] } {
  return { keys: [set.signing, ...set.retired].map((key) => key.publicJwk) };
}
