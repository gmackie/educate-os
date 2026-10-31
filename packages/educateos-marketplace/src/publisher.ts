// Marketplace publishers (SCHO-209). A publisher signs its own listings with its own key; a
// publisher credential is a release key's statement that a key belongs to a named publisher. The
// district already pins the release keys (`@educateos/releases`), so it can check a credential, and
// through it a listing, offline. The offline root keys never sign credentials; they only sign the
// release key sets that change which release keys are trusted.
import { EducateOsError, UtcTimestamp } from "@educateos/contracts";
import { Ed25519PublicKey, KeyId, keyIdFor, SignedEnvelope, type SigningIdentity } from "@educateos/fleet";
import { openReleaseMessage, type ReleaseTrust, signReleaseMessage } from "@educateos/releases";
import { z } from "zod";

const Text = (max: number) => z.string().trim().min(1).max(max);

/** Names a publisher: a lowercase slug such as `educateos` or `prairie-press`. */
export const PublisherId = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, "expected a lowercase slug");
/** A publisher identifier. */
export type PublisherId = z.infer<typeof PublisherId>;

/** A publisher's listing-signing key. The key ID is derived from the key and checked on every use. */
export const PublisherKey = z.strictObject({
  keyId: KeyId,
  publicKey: Ed25519PublicKey,
});
/** A publisher key. */
export type PublisherKey = z.infer<typeof PublisherKey>;

/** Who publishes a listing, as the marketplace vouches for them. */
export const MarketplacePublisher = z.strictObject({
  publisherId: PublisherId,
  displayName: Text(200),
  website: z.url({ protocol: /^https$/ }).max(2048).optional(),
  key: PublisherKey,
});
/** A marketplace publisher. */
export type MarketplacePublisher = z.infer<typeof MarketplacePublisher>;

/**
 * What a release key asserts about a publisher: that `publisher.key` signs that publisher's
 * listings, from `issuedAt` until `expiresAt`. A district installs a listing only while its
 * publisher's credential is current; a pack it already installed keeps working after the credential
 * expires (ADR-0013 decision 3).
 */
export const PublisherCredential = z
  .strictObject({
    publisher: MarketplacePublisher,
    issuedAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  })
  .refine((credential) => Date.parse(credential.issuedAt) < Date.parse(credential.expiresAt), {
    path: ["expiresAt"],
    message: "expected expiresAt after issuedAt",
  });
/** A publisher credential. */
export type PublisherCredential = z.infer<typeof PublisherCredential>;

/**
 * Signs a publisher credential with a release key, as the marketplace does when it admits a
 * publisher. The credential is parsed first, and its key ID must match its key.
 */
export async function signPublisherCredential(releaseKey: SigningIdentity, credential: PublisherCredential): Promise<SignedEnvelope> {
  const parsed = PublisherCredential.parse(credential);
  if ((await keyIdFor(parsed.publisher.key.publicKey)) !== parsed.publisher.key.keyId) {
    throw new EducateOsError("validation-failed", "the publisher's key ID does not match its key");
  }
  return signReleaseMessage(releaseKey, "marketplace-publisher", parsed);
}

/**
 * Opens a publisher credential: a release key the district trusts at `now` must have signed it as a
 * `marketplace-publisher` message, its publisher key ID must match its key, and `now` must fall in
 * its validity window. Returns undefined, never throws, for any failure, so every refusal takes the
 * caller's one rejection path.
 */
export async function openPublisherCredential(input: unknown, trust: ReleaseTrust, now: Date): Promise<PublisherCredential | undefined> {
  const envelope = SignedEnvelope.safeParse(input);
  if (!envelope.success) return undefined;
  const credential = await openReleaseMessage(envelope.data, "marketplace-publisher", PublisherCredential, trust, now);
  if (credential === undefined) return undefined;
  if ((await keyIdFor(credential.publisher.key.publicKey)) !== credential.publisher.key.keyId) return undefined;
  const at = now.getTime();
  if (at < Date.parse(credential.issuedAt) || at >= Date.parse(credential.expiresAt)) return undefined;
  return credential;
}
