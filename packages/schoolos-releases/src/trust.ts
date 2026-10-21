import { SchoolOsError } from "@schoolos/contracts";
import {
  canonicalJson,
  Ed25519PublicKey,
  KeyId,
  keyIdFor,
  parseWire,
  SignedEnvelope,
  type SigningIdentity,
  UtcTimestamp,
  verifySignature,
} from "@schoolos/fleet";
import { z } from "zod";

/**
 * The kinds of message a root release key signs in this package's own signing context. Offers are
 * signed in the fleet protocol's context instead (kind `release-offer`), and because the contexts
 * differ, no signature made for one ever verifies as the other.
 */
export const ReleaseMessageKind = z.enum(["release-manifest", "release-key-announcement"]);
/** A release message kind. */
export type ReleaseMessageKind = z.infer<typeof ReleaseMessageKind>;

const RELEASE_CONTEXT = "schoolos-releases/v1";

function signedBytes(kind: ReleaseMessageKind, payload: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${RELEASE_CONTEXT}\0${kind}\0${canonicalJson(payload)}`);
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
 * One root release public key the district trusts. The key ID is derived from the key and checked
 * on every use, so a pinned entry can't name one key and hold another. A key with `retiresAt` is
 * trusted only before that moment: that is the overlap a rotation gives the old key.
 */
export const TrustedReleaseKey = z.strictObject({
  keyId: KeyId,
  publicKey: Ed25519PublicKey,
  retiresAt: UtcTimestamp.optional(),
});
/** A trusted release key. */
export type TrustedReleaseKey = z.infer<typeof TrustedReleaseKey>;

/**
 * The root release keys a district pins. It starts as the keys in the district's install
 * configuration and changes only through {@link acceptKeyAnnouncement}, which needs a signature by
 * a key already in it. Nothing the root sends alongside a signature is ever trusted as a key.
 */
export const ReleaseTrust = z.strictObject({
  keys: z.array(TrustedReleaseKey).min(1).max(16),
});
/** A district's pinned release trust. */
export type ReleaseTrust = z.infer<typeof ReleaseTrust>;

/** Builds a {@link ReleaseTrust} pinning the given public keys, deriving their key IDs. */
export async function pinReleaseKeys(publicKeys: readonly Ed25519PublicKey[]): Promise<ReleaseTrust> {
  return ReleaseTrust.parse({
    keys: await Promise.all(publicKeys.map(async (publicKey) => ({ keyId: await keyIdFor(publicKey), publicKey }))),
  });
}

function isTrustedAt(key: TrustedReleaseKey, now: Date): boolean {
  return key.retiresAt === undefined || now.getTime() < Date.parse(key.retiresAt);
}

/** The pinned key with this ID, if there is one and it has not retired by `now`. */
export function trustedKey(trust: ReleaseTrust, keyId: string, now: Date): TrustedReleaseKey | undefined {
  const key = trust.keys.find((candidate) => candidate.keyId === keyId);
  return key !== undefined && isTrustedAt(key, now) ? key : undefined;
}

/**
 * Verifies a release message against the pinned trust, returning its parsed payload or undefined.
 * Never throws for a bad signature, an unknown or retired key, or a malformed payload, so every
 * failure takes the caller's single rejection path.
 */
export async function openReleaseMessage<T extends z.ZodType>(
  envelope: SignedEnvelope,
  kind: ReleaseMessageKind,
  schema: T,
  trust: ReleaseTrust,
  now: Date,
): Promise<z.infer<T> | undefined> {
  const key = trustedKey(trust, envelope.keyId, now);
  if (key === undefined) return undefined;
  if ((await keyIdFor(key.publicKey)) !== key.keyId) return undefined;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = signedBytes(kind, envelope.payload);
  } catch {
    return undefined;
  }
  if (!(await verifySignature(key.publicKey, envelope.signature, bytes))) return undefined;
  const parsed = schema.safeParse(envelope.payload);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The root introducing a new release key, signed by a key the district already trusts. The
 * signing key keeps working until `signerRetiresAt`, so for that overlap releases signed by either
 * key verify, and districts that have not yet seen the announcement keep working too.
 */
export const KeyAnnouncement = z
  .strictObject({
    keyId: KeyId,
    publicKey: Ed25519PublicKey,
    announcedAt: UtcTimestamp,
    signerRetiresAt: UtcTimestamp,
  })
  .refine((a) => Date.parse(a.announcedAt) <= Date.parse(a.signerRetiresAt), {
    message: "expected announcedAt <= signerRetiresAt",
  });
/** A key announcement. */
export type KeyAnnouncement = z.infer<typeof KeyAnnouncement>;

/**
 * Applies a key announcement to the pinned trust and returns the new trust: the announced key is
 * added and the signing key retires at the announced time (never later than an earlier retirement
 * already pinned). Keys past retirement are dropped. Fails with `unauthenticated` unless a
 * currently trusted key signed it.
 *
 * A stolen release key can announce a key of the thief's, so rotation is not a defence against
 * root compromise; the district's approval of every offer is (threat model T12).
 */
export async function acceptKeyAnnouncement(trust: ReleaseTrust, input: unknown, now: Date): Promise<ReleaseTrust> {
  const envelope = parseWire(SignedEnvelope, input, "envelope");
  const announcement = await openReleaseMessage(envelope, "release-key-announcement", KeyAnnouncement, trust, now);
  if (
    announcement === undefined ||
    announcement.keyId === envelope.keyId ||
    (await keyIdFor(announcement.publicKey)) !== announcement.keyId
  ) {
    throw new SchoolOsError("unauthenticated", "key announcement not accepted");
  }
  const keys = trust.keys.map((key) => {
    if (key.keyId !== envelope.keyId) return key;
    const retiresAt = key.retiresAt !== undefined && Date.parse(key.retiresAt) < Date.parse(announcement.signerRetiresAt)
      ? key.retiresAt
      : announcement.signerRetiresAt;
    return { ...key, retiresAt };
  });
  if (!keys.some((key) => key.keyId === announcement.keyId)) {
    keys.push({ keyId: announcement.keyId, publicKey: announcement.publicKey });
  }
  return ReleaseTrust.parse({ keys: keys.filter((key) => isTrustedAt(key, now)) });
}
