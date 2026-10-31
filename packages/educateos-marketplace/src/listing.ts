// Marketplace listings (SCHO-209): what a publisher offers, signed with its own key, and the bundle
// educateos.io serves for a district to install. The district checks a bundle offline: the
// credential against the release keys it pins, the listing against the credential's publisher key,
// and the content against the listing's digest. Nothing here asks educateos.io anything, and no
// runtime code ever checks an entitlement (ADR-0013 decisions 1 and 3).
import { EducateOsError, UtcTimestamp } from "@educateos/contracts";
import { canonicalJson, SignedEnvelope, type SigningIdentity, verifySignature } from "@educateos/fleet";
import type { ReleaseTrust } from "@educateos/releases";
import { z } from "zod";
import { CurriculumPackContent, listingContentDigest } from "./content.ts";
import { type MarketplacePublisher, openPublisherCredential, PublisherId } from "./publisher.ts";

const Text = (max: number) => z.string().trim().min(1).max(max);

/** Names a listing: a lowercase slug, unique among its publisher's listings. */
export const ListingId = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/, "expected a lowercase slug");
/** A listing identifier. */
export type ListingId = z.infer<typeof ListingId>;

/**
 * What a listing delivers. Only curriculum packs today; blueprints, capability packs and LTI tools
 * (once a district can host one, IF-10) will be further kinds, each with its own content schema.
 */
export const ListingKind = z.enum(["curriculum-pack"]);
/** A listing kind. */
export type ListingKind = z.infer<typeof ListingKind>;

/**
 * What a listing costs. Only `free` exists. A paid listing will be a further variant, delivered as
 * a per-purchase signed artifact; a district refuses any model it does not know, so adding one
 * never makes an older district install something it was not built to handle.
 */
export const ListingPricing = z.discriminatedUnion("model", [
  z.strictObject({ model: z.literal("free") }),
]);
/** A listing's pricing. */
export type ListingPricing = z.infer<typeof ListingPricing>;

/** The licence the content is offered under, as the publisher states it. */
export const ListingLicense = z.strictObject({
  name: Text(200),
  url: z.url({ protocol: /^https$/ }).max(2048).optional(),
  attribution: Text(2000).optional(),
});
/** A listing licence. */
export type ListingLicense = z.infer<typeof ListingLicense>;

/** What a publisher signs: one version of one listing, bound to its content by digest. */
export const ListingStatement = z.strictObject({
  listingId: ListingId,
  publisherId: PublisherId,
  kind: ListingKind,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a version such as 1.2.0"),
  releasedAt: UtcTimestamp,
  title: Text(200),
  summary: Text(1000),
  license: ListingLicense,
  pricing: ListingPricing,
  contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex digits>"),
});
/** A listing statement. */
export type ListingStatement = z.infer<typeof ListingStatement>;

/** The format tag of a listing bundle. */
export const LISTING_BUNDLE_FORMAT = "educateos.marketplace.listing/v1";

/** A listing as educateos.io serves it: the publisher's credential, its signed listing and the content. */
export const ListingBundle = z.strictObject({
  format: z.literal(LISTING_BUNDLE_FORMAT),
  credential: SignedEnvelope,
  listing: SignedEnvelope,
  content: z.json(),
});
/** A listing bundle. */
export type ListingBundle = z.infer<typeof ListingBundle>;

// Publisher signatures are made in their own context, so no listing signature is ever a valid
// release or fleet message, nor the reverse, even if a publisher reused a release key.
const LISTING_CONTEXT = "educateos-marketplace/v1";

// `slice()` gives a view over a plain `ArrayBuffer` under every runtime's typings (ADR-0009).
function listingBytes(payload: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${LISTING_CONTEXT}\0listing\0${canonicalJson(payload)}`).slice();
}

/** What {@link buildListingBundle} signs and packs. */
export interface ListingBundleInput {
  /** The publisher's credential, as {@link signPublisherCredential} made it. */
  credential: SignedEnvelope;
  /** The publisher's listing-signing key; it must be the credential's key. */
  publisherKey: SigningIdentity;
  /** The listing, without its digest, which is computed from `content`. */
  listing: Omit<ListingStatement, "contentDigest">;
  content: CurriculumPackContent;
}

/**
 * Signs a listing with the publisher's key and packs it with its credential and content, as the
 * publish script does. The content and listing are parsed first, so only an installable listing
 * can be signed.
 */
export async function buildListingBundle(input: ListingBundleInput): Promise<ListingBundle> {
  const content: unknown = JSON.parse(canonicalJson(CurriculumPackContent.parse(input.content)));
  const statement = ListingStatement.parse({ ...input.listing, contentDigest: await listingContentDigest(content) });
  return ListingBundle.parse({
    format: LISTING_BUNDLE_FORMAT,
    credential: input.credential,
    listing: {
      payload: JSON.parse(canonicalJson(statement)),
      signature: await input.publisherKey.sign(listingBytes(statement)),
      keyId: input.publisherKey.keyId,
    },
    content,
  });
}

/** A bundle that passed {@link verifyListingBundle}. */
export interface VerifiedListing {
  publisher: MarketplacePublisher;
  /** The release key that signed the publisher's credential. */
  credentialKeyId: string;
  listing: ListingStatement;
  content: CurriculumPackContent;
}

const refused = () => new EducateOsError("unauthenticated", "listing signature not accepted");

/**
 * Verifies a listing bundle offline and returns what it delivers.
 *
 * @throws EducateOsError `validation-failed` for a malformed bundle, or content that does not match
 *   its digest or is not an installable curriculum pack; `unauthenticated` when the credential was
 *   not signed by a release key `trust` holds at `now`, is outside its validity window, or names
 *   another publisher, or when the listing is not signed by the credential's key; and `conflict`
 *   for a listing whose pricing this version cannot install (anything but free).
 */
export async function verifyListingBundle(input: unknown, trust: ReleaseTrust, now: Date): Promise<VerifiedListing> {
  const bundle = ListingBundle.safeParse(input);
  if (!bundle.success) throw new EducateOsError("validation-failed", "malformed listing bundle");
  const credential = await openPublisherCredential(bundle.data.credential, trust, now);
  if (credential === undefined) throw refused();
  const { publisher } = credential;
  const { listing } = bundle.data;
  if (listing.keyId !== publisher.key.keyId) throw refused();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = listingBytes(listing.payload);
  } catch {
    throw refused();
  }
  if (!(await verifySignature(publisher.key.publicKey, listing.signature, bytes))) throw refused();
  // The signature is genuine from here on, so a payload that does not parse was signed that way.
  const statement = ListingStatement.safeParse(listing.payload);
  if (!statement.success) {
    const pricing = (listing.payload as { pricing?: { model?: unknown } } | null)?.pricing;
    if (typeof pricing?.model === "string" && pricing.model !== "free") {
      throw new EducateOsError("conflict", "this listing is not free; this version of EducateOS installs free listings only");
    }
    throw new EducateOsError("validation-failed", "the listing is not one this version of EducateOS can install");
  }
  if (statement.data.publisherId !== publisher.publisherId) throw refused();
  if ((await listingContentDigest(bundle.data.content)) !== statement.data.contentDigest) {
    throw new EducateOsError("validation-failed", "the listing's content does not match its digest");
  }
  const content = CurriculumPackContent.safeParse(bundle.data.content);
  if (!content.success) throw new EducateOsError("validation-failed", "the listing's content is not an installable curriculum pack");
  return { publisher, credentialKeyId: bundle.data.credential.keyId, listing: statement.data, content: content.data };
}
