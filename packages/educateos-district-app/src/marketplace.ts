// Marketplace installs (SCHO-209): curriculum packs a district administrator installs from a signed
// marketplace listing. The administrator sends the listing bundle they downloaded; the district
// verifies it here, offline, against the release keys it pins for the marketplace, and never
// fetches anything from educateos.io (ADR-0013). Teachers then create activities in their own
// classes from a pack's templates through the curriculum service.
import { EducateOsError, PrincipalId, UtcTimestamp } from "@educateos/contracts";
import {
  CurriculumPackContent,
  ListingStatement,
  MarketplacePublisher,
  verifyListingBundle,
} from "@educateos/marketplace";
import type { ReleaseTrust } from "@educateos/releases";
import { z } from "zod";
import type { MarketplacePackBody, MarketplacePackTemplatesBody } from "./routes.ts";

/** One curriculum pack the district installed: the verified listing, its content, and who installed it. */
export const InstalledPack = z.strictObject({
  publisher: MarketplacePublisher,
  /** The release key that signed the publisher's credential when it was installed. */
  credentialKeyId: z.string().min(1).max(200),
  listing: ListingStatement,
  content: CurriculumPackContent,
  installedBy: PrincipalId,
  installedAt: UtcTimestamp,
});
/** An installed pack. */
export type InstalledPack = z.infer<typeof InstalledPack>;

/**
 * The district's installed packs, oldest first. Append-only: each version of a listing is installed
 * once, and a later version is a new entry beside it.
 */
export interface MarketplacePackStore {
  /** Every installed pack, oldest first. */
  list(): Promise<InstalledPack[]>;
  /**
   * Adds a pack unless that publisher's listing at that version is already installed, atomically,
   * and returns the entry that is now installed for it: `pack`, or the one already there.
   */
  add(pack: InstalledPack): Promise<InstalledPack>;
}

/** Whether two packs are the same version of the same publisher's listing. */
export const sameRelease = (a: InstalledPack, b: InstalledPack): boolean =>
  a.publisher.publisherId === b.publisher.publisherId && a.listing.listingId === b.listing.listingId && a.listing.version === b.listing.version;

/** A {@link MarketplacePackStore} in memory. */
export class InMemoryMarketplacePackStore implements MarketplacePackStore {
  readonly #packs: InstalledPack[] = [];

  async list(): Promise<InstalledPack[]> {
    return structuredClone(this.#packs);
  }

  async add(pack: InstalledPack): Promise<InstalledPack> {
    const existing = this.#packs.find((p) => sameRelease(p, pack));
    if (existing !== undefined) return structuredClone(existing);
    this.#packs.push(structuredClone(pack));
    return structuredClone(pack);
  }
}

/** The listing entry for an installed pack. */
export function packBody(pack: InstalledPack): MarketplacePackBody {
  const { publisher, listing, content } = pack;
  return {
    publisher: { publisherId: publisher.publisherId, displayName: publisher.displayName, ...(publisher.website === undefined ? {} : { website: publisher.website }) },
    listingId: listing.listingId,
    version: listing.version,
    title: listing.title,
    summary: listing.summary,
    license: listing.license,
    pricing: listing.pricing,
    contentDigest: listing.contentDigest,
    subjects: content.subjects,
    gradeBands: content.gradeBands,
    activities: content.activities.map((a) => ({ key: a.key, template: a.template.template, title: a.template.title })),
    installed: { by: pack.installedBy, at: pack.installedAt },
  };
}

/** The packs a teacher may create activities from: the latest installed version of each listing. */
export function packTemplates(packs: readonly InstalledPack[]): MarketplacePackTemplatesBody[] {
  const latest = new Map<string, InstalledPack>();
  for (const pack of packs) latest.set(`${pack.publisher.publisherId}/${pack.listing.listingId}`, pack);
  return [...latest.values()].map((pack) => ({
    publisher: { publisherId: pack.publisher.publisherId, displayName: pack.publisher.displayName },
    listingId: pack.listing.listingId,
    version: pack.listing.version,
    title: pack.listing.title,
    license: pack.listing.license,
    activities: pack.content.activities.map((a) => ({ key: a.key, template: a.template })),
  }));
}

const MAX_PACK_CHARS = 1024 * 1024;

/**
 * Verifies a listing bundle against the district's marketplace trust and installs its pack.
 * Installing a version already installed changes nothing and answers with the installed entry; the
 * same version with other content is refused, since a release never changes.
 *
 * @throws EducateOsError `unavailable` if the district pins no marketplace keys, `conflict` for a
 *   version already installed with other content, `validation-failed` for a pack over 1 MB of JSON,
 *   and whatever `verifyListingBundle` throws.
 */
export async function installListing(
  store: MarketplacePackStore,
  trust: ReleaseTrust | undefined,
  bundle: unknown,
  actor: { by: PrincipalId; at: string },
): Promise<InstalledPack> {
  if (trust === undefined) {
    throw new EducateOsError("unavailable", "This district does not pin marketplace keys, so it cannot install marketplace listings.");
  }
  const verified = await verifyListingBundle(bundle, trust, new Date(actor.at));
  const pack = InstalledPack.parse({ ...verified, installedBy: actor.by, installedAt: actor.at });
  // Kept as one SQLite row, whose values are limited to 2 MB.
  if (JSON.stringify(pack).length > MAX_PACK_CHARS) throw new EducateOsError("validation-failed", "This pack is too large to install.");
  const installed = await store.add(pack);
  if (installed.listing.contentDigest !== pack.listing.contentDigest) {
    throw new EducateOsError("conflict", `${pack.listing.listingId} ${pack.listing.version} is already installed with other content.`);
  }
  return installed;
}
