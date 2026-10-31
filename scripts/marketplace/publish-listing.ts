#!/usr/bin/env node

// Publishes marketplace listings on educateos.io (SCHO-209) as static files. Two steps, because two
// different key holders sign:
//
//   EDUCATEOS_RELEASE_SIGNING_KEY=… node scripts/marketplace/publish-listing.ts credential <publisherId> [--valid-days 365]
//       A release key vouches for a publisher's listing key: signs the publisher in
//       sites/educateos-io/marketplace/publishers/<publisherId>.json into its credential.
//   EDUCATEOS_MARKETPLACE_PUBLISHER_KEY=… node scripts/marketplace/publish-listing.ts listing <listingId>
//       The publisher signs one listing (marketplace/listings/<listingId>/listing.json and pack.json)
//       and packs it with its credential into the bundle districts install.
//   node scripts/marketplace/publish-listing.ts index
//       Rebuilds the marketplace index from the published bundles (`listing` does this too).
//
// Both keys are Ed25519 private JWKs from the environment, never written to disk or printed, and an
// error about one never quotes it. Every file written is checked first against the release keys the
// site pins (`RELEASE_TRUST` in sites/educateos-io/wrangler.jsonc, the demo districts' marketplace
// trust too), so nothing a district pinning them would refuse is published. The site Worker only
// serves the files: no listing is signed or checked at request time.
//
// Imported by relative path, like scripts/release does with its packages (see release-signing.ts).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Ed25519PrivateJwk, type SignedEnvelope, SigningIdentity } from "../../packages/educateos-fleet/src/index.ts";
import {
  buildListingBundle,
  CurriculumPackContent,
  type ListingBundle,
  ListingStatement,
  MarketplacePublisher,
  openPublisherCredential,
  signPublisherCredential,
  type VerifiedListing,
  verifyListingBundle,
} from "../../packages/educateos-marketplace/src/index.ts";
import { ReleaseTrust } from "../../packages/educateos-releases/src/index.ts";
import { RELEASE_SIGNING_KEY_ENV, releaseSigningKey } from "../release/release-signing.ts";

/** The environment variable holding a publisher's listing key, an Ed25519 private JWK as JSON. */
export const PUBLISHER_KEY_ENV = "EDUCATEOS_MARKETPLACE_PUBLISHER_KEY";

/** How long a publisher credential is valid by default. */
export const DEFAULT_CREDENTIAL_DAYS = 365;

const DAY_MS = 24 * 60 * 60_000;

const SITE = join(dirname(fileURLToPath(import.meta.url)), "../../sites/educateos-io");

/** Where the marketplace's sources are read and its files written. */
export const MARKETPLACE_PATHS = {
  sources: join(SITE, "marketplace"),
  public: join(SITE, "public/marketplace"),
} as const;

/** The release keys educateos.io pins: `RELEASE_TRUST` in the site Worker's config. */
export function siteReleaseTrust(): ReleaseTrust {
  // jsonc-parser is a dependency of this package, as the production configs read it here too.
  const { parse } = createRequire(import.meta.url)("jsonc-parser") as { parse(text: string): { vars?: { RELEASE_TRUST?: unknown } } };
  return ReleaseTrust.parse(parse(readFileSync(join(SITE, "wrangler.jsonc"), "utf8")).vars?.RELEASE_TRUST);
}

/** The publisher's listing key from the environment. A value that is not an Ed25519 private JWK fails without quoting it. */
export async function publisherKey(env: Record<string, string | undefined>): Promise<SigningIdentity> {
  const value = env[PUBLISHER_KEY_ENV]?.trim();
  if (!value) throw new Error(`${PUBLISHER_KEY_ENV} is not set`);
  try {
    return await SigningIdentity.fromJwk(Ed25519PrivateJwk.parse(JSON.parse(value)));
  } catch {
    throw new Error(`${PUBLISHER_KEY_ENV} is not an Ed25519 private JWK ({ kty: "OKP", crv: "Ed25519", x, d })`);
  }
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

/** The path of a publisher's published credential. */
export const credentialPath = (publisherId: string) => join(MARKETPLACE_PATHS.public, "publishers", `${publisherId}.json`);
/** The site path of a listing version's bundle. */
export const bundleUrl = (listingId: string, version: string) => `/marketplace/listings/${listingId}/${version}.json`;

/**
 * Signs a publisher's credential with a release key, refusing a credential `trust` would not
 * accept now: a key the site does not pin can't publish anything districts would install.
 */
export async function issueCredential(
  releaseKey: SigningIdentity,
  publisher: MarketplacePublisher,
  trust: ReleaseTrust,
  options: { now?: Date; validDays?: number } = {},
): Promise<SignedEnvelope> {
  const now = options.now ?? new Date();
  const credential = await signPublisherCredential(releaseKey, {
    publisher: MarketplacePublisher.parse(publisher),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (options.validDays ?? DEFAULT_CREDENTIAL_DAYS) * DAY_MS).toISOString(),
  });
  if ((await openPublisherCredential(credential, trust, now)) === undefined) {
    throw new Error(`${RELEASE_SIGNING_KEY_ENV} is not a release key the site pins (RELEASE_TRUST), so no district would accept its credential`);
  }
  return credential;
}

/**
 * Signs a listing with the publisher's key and packs it with its credential, refusing a bundle
 * `trust` would not install now.
 */
export async function signListing(
  key: SigningIdentity,
  credential: SignedEnvelope,
  sources: { listing: unknown; pack: unknown },
  trust: ReleaseTrust,
  now = new Date(),
): Promise<ListingBundle> {
  const listing = ListingStatement.omit({ contentDigest: true }).parse(sources.listing);
  const bundle = await buildListingBundle({ credential, publisherKey: key, listing, content: CurriculumPackContent.parse(sources.pack) });
  await verifyListingBundle(bundle, trust, now);
  return bundle;
}

/** One listing in the marketplace index: its latest published version. */
export interface IndexEntry {
  listingId: string;
  version: string;
  title: string;
  summary: string;
  kind: VerifiedListing["listing"]["kind"];
  pricing: VerifiedListing["listing"]["pricing"];
  license: VerifiedListing["listing"]["license"];
  releasedAt: string;
  contentDigest: string;
  publisher: { publisherId: string; displayName: string; website?: string };
  subjects: string[];
  gradeBands: string[];
  activities: { key: string; title: string; template: string }[];
  /** The bundle's path on the site. */
  bundle: string;
}

/** Every published bundle, verified against `trust` at `now`. A bundle that does not verify fails the read. */
export async function readPublishedListings(trust: ReleaseTrust, now = new Date()): Promise<VerifiedListing[]> {
  const root = join(MARKETPLACE_PATHS.public, "listings");
  let listingIds: string[];
  try {
    listingIds = readdirSync(root).toSorted();
  } catch {
    return [];
  }
  const verified: VerifiedListing[] = [];
  for (const listingId of listingIds) {
    for (const file of readdirSync(join(root, listingId)).filter((f) => f.endsWith(".json")).toSorted()) {
      const listing = await verifyListingBundle(readJson(join(root, listingId, file)), trust, now);
      if (listing.listing.listingId !== listingId || `${listing.listing.version}.json` !== file) {
        throw new Error(`${listingId}/${file} holds ${listing.listing.listingId} ${listing.listing.version}`);
      }
      verified.push(listing);
    }
  }
  return verified;
}

const versionParts = (version: string) => version.split(".").map(Number);
const newer = (a: string, b: string) => {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

/** The index of the latest version of each listing, by listing ID. */
export function marketplaceIndex(listings: readonly VerifiedListing[]): IndexEntry[] {
  const latest = new Map<string, VerifiedListing>();
  for (const listing of listings) {
    const current = latest.get(listing.listing.listingId);
    if (current === undefined || newer(listing.listing.version, current.listing.version)) latest.set(listing.listing.listingId, listing);
  }
  return [...latest.values()].toSorted((a, b) => a.listing.title.localeCompare(b.listing.title)).map(({ publisher, listing, content }) => ({
    listingId: listing.listingId,
    version: listing.version,
    title: listing.title,
    summary: listing.summary,
    kind: listing.kind,
    pricing: listing.pricing,
    license: listing.license,
    releasedAt: listing.releasedAt,
    contentDigest: listing.contentDigest,
    publisher: { publisherId: publisher.publisherId, displayName: publisher.displayName, ...(publisher.website === undefined ? {} : { website: publisher.website }) },
    subjects: [...content.subjects],
    gradeBands: [...content.gradeBands],
    activities: content.activities.map((a) => ({ key: a.key, title: a.template.title, template: a.template.template })),
    bundle: bundleUrl(listing.listingId, listing.version),
  }));
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const TEMPLATE_NAMES: Record<string, string> = {
  "writing-task": "Writing task",
  "science-investigation": "Science investigation",
  "problem-set": "Problem set",
};

/** The listing cards of the marketplace page, for between its `<!-- marketplace:listings -->` markers. */
export function renderListingCards(index: readonly IndexEntry[]): string {
  if (index.length === 0) return `<p class="muted">No listings yet.</p>`;
  return index.map((entry) => {
    const license = entry.license.url === undefined
      ? escapeHtml(entry.license.name)
      : `<a href="${escapeHtml(entry.license.url)}">${escapeHtml(entry.license.name)}</a>`;
    const activities = entry.activities
      .map((a) => `<li>${escapeHtml(a.title)} <span class="muted">(${escapeHtml(TEMPLATE_NAMES[a.template] ?? a.template)})</span></li>`)
      .join("");
    return [
      `<article class="card listing" id="${escapeHtml(entry.listingId)}">`,
      `  <h3>${escapeHtml(entry.title)}</h3>`,
      `  <p class="muted">${escapeHtml(entry.publisher.displayName)} · version ${escapeHtml(entry.version)} · Free · ${license}</p>`,
      `  <p>${escapeHtml(entry.summary)}</p>`,
      `  <ul>${activities}</ul>`,
      `  <p><a class="btn" href="${escapeHtml(entry.bundle)}" download>Download the signed listing</a></p>`,
      `  <p class="muted small">Content digest <code>${escapeHtml(entry.contentDigest)}</code></p>`,
      `</article>`,
    ].join("\n");
  }).join("\n");
}

const CARDS = /<!-- marketplace:listings -->[\s\S]*?<!-- \/marketplace:listings -->/;

/** The marketplace page with its listing cards replaced by `index`'s. */
export function stampMarketplacePage(html: string, index: readonly IndexEntry[]): string {
  if (!CARDS.test(html)) throw new Error("public/marketplace/index.html is missing its <!-- marketplace:listings --> markers");
  return html.replace(CARDS, () => `<!-- marketplace:listings -->\n${renderListingCards(index)}\n<!-- /marketplace:listings -->`);
}

/** Rebuilds `index.json` and the page's cards from the published bundles. */
export async function writeIndex(trust: ReleaseTrust, now = new Date()): Promise<IndexEntry[]> {
  const index = marketplaceIndex(await readPublishedListings(trust, now));
  writeJson(join(MARKETPLACE_PATHS.public, "index.json"), { listings: index });
  const page = join(MARKETPLACE_PATHS.public, "index.html");
  writeFileSync(page, stampMarketplacePage(readFileSync(page, "utf8"), index));
  return index;
}

async function main(argv: string[]): Promise<void> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { "valid-days": { type: "string" } } });
  const [command, id] = positionals;
  const trust = siteReleaseTrust();
  if (command === "credential" && id !== undefined) {
    const releaseKey = await releaseSigningKey(process.env);
    if (releaseKey === undefined) throw new Error(`${RELEASE_SIGNING_KEY_ENV} is not set`);
    const publisher = MarketplacePublisher.parse(readJson(join(MARKETPLACE_PATHS.sources, "publishers", `${id}.json`)));
    const validDays = values["valid-days"] === undefined ? undefined : Number(values["valid-days"]);
    writeJson(credentialPath(id), await issueCredential(releaseKey, publisher, trust, validDays === undefined ? {} : { validDays }));
    console.log(`wrote ${credentialPath(id)}`);
  } else if (command === "listing" && id !== undefined) {
    const key = await publisherKey(process.env);
    const sources = join(MARKETPLACE_PATHS.sources, "listings", id);
    const listing = readJson(join(sources, "listing.json"));
    const publisherId = ListingStatement.shape.publisherId.parse((listing as { publisherId?: unknown }).publisherId);
    const credential = readJson(credentialPath(publisherId)) as SignedEnvelope;
    const bundle = await signListing(key, credential, { listing, pack: readJson(join(sources, "pack.json")) }, trust);
    const { version } = ListingStatement.parse(bundle.listing.payload);
    const path = join(SITE, "public", bundleUrl(id, version));
    writeJson(path, bundle);
    console.log(`wrote ${path}`);
    console.log(`indexed ${(await writeIndex(trust)).length} listing(s)`);
  } else if (command === "index") {
    console.log(`indexed ${(await writeIndex(trust)).length} listing(s)`);
  } else {
    throw new Error("usage: publish-listing.ts credential <publisherId> [--valid-days N] | listing <listingId> | index");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
