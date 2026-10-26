import { EducateOsError, UtcTimestamp } from "@educateos/contracts";
import {
  canonicalJson,
  Ed25519PublicKey,
  Ed25519Signature,
  KeyId,
  keyIdFor,
  parseWire,
  type SignedEnvelope,
  type SigningIdentity,
  verifySignature,
} from "@educateos/fleet";
import { z } from "zod";

/**
 * The kinds of message signed in this package's own signing context: release manifests (by a
 * release key) and release key sets (by offline root keys). Offers are signed in the fleet
 * protocol's context instead (kind `release-offer`), and because the contexts and kinds differ, no
 * signature made for one ever verifies as another. `catalog-release` is a framework catalog release
 * statement (`@educateos/catalog`), signed by a release key: the kind is part of the signed bytes, so
 * a catalog signature can never pass as a manifest's, or the reverse.
 */
export const ReleaseMessageKind = z.enum(["release-manifest", "release-key-set", "catalog-release"]);
/** A release message kind. */
export type ReleaseMessageKind = z.infer<typeof ReleaseMessageKind>;

const RELEASE_CONTEXT = "educateos-releases/v1";
/** SCHO-232: the context of release messages signed before the EducateOS rename, which still verify. */
const LEGACY_RELEASE_CONTEXT = "schoolos-releases/v1"; // rename-educateos: keep

// `slice()` gives a view over a plain `ArrayBuffer` under every runtime's typings (ADR-0009).
function signedBytes(kind: ReleaseMessageKind, payload: unknown, context = RELEASE_CONTEXT): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${context}\0${kind}\0${canonicalJson(payload)}`).slice();
}

/** Signs a payload as a release message of `kind`, in the fleet's envelope shape. */
export async function signReleaseMessage(
  identity: SigningIdentity,
  kind: ReleaseMessageKind,
  payload: unknown,
): Promise<SignedEnvelope> {
  return {
    payload: JSON.parse(canonicalJson(payload)),
    signature: await identity.sign(signedBytes(kind, payload)),
    keyId: identity.keyId,
  };
}

/**
 * One online release-signing key the district trusts: the keys that sign release manifests and
 * offers. The key ID is derived from the key and checked on every use, so a pinned entry can't
 * name one key and hold another. A key with `retiresAt` is trusted only before that moment: that
 * is the overlap a rotation gives the old key.
 */
export const TrustedReleaseKey = z.strictObject({
  keyId: KeyId,
  publicKey: Ed25519PublicKey,
  retiresAt: UtcTimestamp.optional(),
});
/** A trusted release key. */
export type TrustedReleaseKey = z.infer<typeof TrustedReleaseKey>;

/** One offline root key: kept off the network and used only, with others, to sign release key sets. */
export const RootKey = z.strictObject({
  keyId: KeyId,
  publicKey: Ed25519PublicKey,
});
/** A root key. */
export type RootKey = z.infer<typeof RootKey>;

/**
 * The district's offline root keys and how many of them must sign a release key set. Pinned at
 * install and never changed by anything the root sends.
 */
export const RootKeyQuorum = z
  .strictObject({
    threshold: z.number().int().min(1),
    keys: z.array(RootKey).min(1).max(16),
  })
  .refine((quorum) => quorum.threshold <= quorum.keys.length, { message: "expected threshold <= the number of root keys" })
  .refine((quorum) => new Set(quorum.keys.map((key) => key.keyId)).size === quorum.keys.length, { message: "expected distinct root keys" });
/** A root key quorum. */
export type RootKeyQuorum = z.infer<typeof RootKeyQuorum>;

/**
 * The root keys a district pins (threat model T12, SCHO-84). Online release keys sign manifests
 * and offers; they can't change this trust. Only a release key set signed by a threshold of the
 * offline root keys can, which replaces the release keys wholesale: that is how the root rotates
 * a key (the old one listed with a `retiresAt`) and how it revokes a stolen one at once (left out).
 * A thief holding a release key, or fewer root keys than the threshold, can't announce a key.
 */
export const ReleaseTrust = z.strictObject({
  root: RootKeyQuorum,
  /** The version of the key set `keys` came from; 0 for the keys pinned at install. */
  keySetVersion: z.number().int().min(0),
  keys: z.array(TrustedReleaseKey).min(1).max(16),
});
/** A district's pinned release trust. */
export type ReleaseTrust = z.infer<typeof ReleaseTrust>;

/** The public keys a district pins at install. */
export interface ReleaseKeyPins {
  /** The online release-signing keys. */
  releaseKeys: readonly Ed25519PublicKey[];
  /** The offline root keys, and how many of them must sign a key set. */
  root: { threshold: number; publicKeys: readonly Ed25519PublicKey[] };
}

/** Builds a {@link ReleaseTrust} pinning the given public keys, deriving their key IDs. */
export async function pinReleaseKeys(pins: ReleaseKeyPins): Promise<ReleaseTrust> {
  return ReleaseTrust.parse({
    root: { threshold: pins.root.threshold, keys: await Promise.all(pins.root.publicKeys.map(pinned)) },
    keySetVersion: 0,
    keys: await Promise.all(pins.releaseKeys.map(pinned)),
  });
}

async function pinned(publicKey: Ed25519PublicKey): Promise<RootKey> {
  return { keyId: await keyIdFor(publicKey), publicKey };
}

function isTrustedAt(key: TrustedReleaseKey, now: Date): boolean {
  return key.retiresAt === undefined || now.getTime() < Date.parse(key.retiresAt);
}

/** The pinned release key with this ID, if there is one and it has not retired by `now`. */
export function trustedKey(trust: ReleaseTrust, keyId: string, now: Date): TrustedReleaseKey | undefined {
  const key = trust.keys.find((candidate) => candidate.keyId === keyId);
  return key !== undefined && isTrustedAt(key, now) ? key : undefined;
}

/**
 * Verifies a release message against the pinned release keys, returning its parsed payload or
 * undefined. Never throws for a bad signature, an unknown or retired key, or a malformed payload,
 * so every failure takes the caller's single rejection path.
 */
export async function openReleaseMessage<T extends z.ZodType>(
  envelope: SignedEnvelope,
  kind: ReleaseMessageKind,
  schema: T,
  trust: ReleaseTrust,
  now: Date,
): Promise<z.infer<T> | undefined> {
  const key = trustedKey(trust, envelope.keyId, now);
  if (key === undefined || !(await verifies(key, envelope.signature, kind, envelope.payload))) return undefined;
  const parsed = schema.safeParse(envelope.payload);
  return parsed.success ? parsed.data : undefined;
}

async function verifies(key: RootKey | TrustedReleaseKey, signature: string, kind: ReleaseMessageKind, payload: unknown): Promise<boolean> {
  if ((await keyIdFor(key.publicKey)) !== key.keyId) return false;
  for (const context of [RELEASE_CONTEXT, LEGACY_RELEASE_CONTEXT]) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = signedBytes(kind, payload, context);
    } catch {
      return false;
    }
    if (await verifySignature(key.publicKey, signature, bytes)) return true;
  }
  return false;
}

/**
 * What the offline root keys assert: the complete set of release keys to trust from now on.
 * `version` only ever increases, so an older set (one that still lists a revoked key) can't be
 * replayed over a newer one.
 */
export const ReleaseKeySet = z
  .strictObject({
    version: z.number().int().min(1),
    keys: z.array(TrustedReleaseKey).min(1).max(16),
    issuedAt: UtcTimestamp,
  })
  .refine((set) => new Set(set.keys.map((key) => key.keyId)).size === set.keys.length, { message: "expected distinct release keys" });
/** A release key set. */
export type ReleaseKeySet = z.infer<typeof ReleaseKeySet>;

/** A release key set with one signature per root key that signed it. */
export const SignedReleaseKeySet = z.strictObject({
  payload: z.json(),
  signatures: z.array(z.strictObject({ keyId: KeyId, signature: Ed25519Signature })).min(1).max(16),
});
/** A signed release key set. */
export type SignedReleaseKeySet = z.infer<typeof SignedReleaseKeySet>;

/**
 * Signs a release key set with each of the given root keys, as the root's offline key ceremony
 * does. The set is parsed first, so only a well-formed set can be signed.
 */
export async function signReleaseKeySet(keySet: ReleaseKeySet, rootKeys: readonly SigningIdentity[]): Promise<SignedReleaseKeySet> {
  const payload = ReleaseKeySet.parse(keySet);
  return {
    payload: JSON.parse(canonicalJson(payload)),
    signatures: await Promise.all(rootKeys.map(async (key) => ({
      keyId: key.keyId,
      signature: await key.sign(signedBytes("release-key-set", payload)),
    }))),
  };
}

/**
 * Applies a release key set to the pinned trust and returns the new trust: its release keys are
 * exactly the set's, less any already retired. It must carry valid signatures from at least
 * `threshold` distinct pinned root keys (`unauthenticated` otherwise; a release key's signature
 * never counts), every key ID must match its key, its version must be newer than the one held
 * (`conflict`), and at least one of its keys must be trusted now (`validation-failed`).
 */
export async function acceptReleaseKeySet(trust: ReleaseTrust, input: unknown, now: Date): Promise<ReleaseTrust> {
  const envelope = parseWire(SignedReleaseKeySet, input, "signed release key set");
  const signers = new Set<string>();
  for (const { keyId, signature } of envelope.signatures) {
    const rootKey = trust.root.keys.find((key) => key.keyId === keyId);
    if (rootKey !== undefined && !signers.has(keyId) && (await verifies(rootKey, signature, "release-key-set", envelope.payload))) {
      signers.add(keyId);
    }
  }
  const keySet = ReleaseKeySet.safeParse(envelope.payload);
  if (signers.size < trust.root.threshold || !keySet.success) {
    throw new EducateOsError("unauthenticated", "release key set not accepted");
  }
  for (const key of keySet.data.keys) {
    if ((await keyIdFor(key.publicKey)) !== key.keyId) throw new EducateOsError("unauthenticated", "release key set not accepted");
  }
  if (keySet.data.version <= trust.keySetVersion) throw new EducateOsError("conflict", "release key set is not newer than the one held");
  const keys = keySet.data.keys.filter((key) => isTrustedAt(key, now));
  if (keys.length === 0) throw new EducateOsError("validation-failed", "release key set has no key trusted now");
  return ReleaseTrust.parse({ root: trust.root, keySetVersion: keySet.data.version, keys });
}
