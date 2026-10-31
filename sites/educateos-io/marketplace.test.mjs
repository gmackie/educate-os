// The educateos.io marketplace (SCHO-209): every published listing installs in a district that pins
// the site's release keys, the index and page list exactly what is published, and the sources and
// the signed bundles agree. Run: node --test sites/educateos-io/marketplace.test.mjs

import assert from "node:assert/strict";
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {test} from "node:test";
import {
  issueCredential,
  MARKETPLACE_PATHS,
  marketplaceIndex,
  readPublishedListings,
  siteReleaseTrust,
  stampMarketplacePage,
} from "../../scripts/marketplace/publish-listing.ts";
import {canonicalJson, SigningIdentity} from "../../packages/educateos-fleet/src/index.ts";
import {CurriculumPackContent} from "../../packages/educateos-marketplace/src/index.ts";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const files = (dir) => readdirSync(dir, {withFileTypes: true}).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);

test("every published listing verifies against the release keys the site pins, today", async () => {
  // A failure here after a year means the publisher's credential expired: issue a new one
  // (scripts/marketplace/publish-listing.ts credential) and re-sign the listings.
  const listings = await readPublishedListings(siteReleaseTrust());
  assert.ok(listings.length >= 1);
  for (const {listing} of listings) assert.deepEqual(listing.pricing, {model: "free"});
});

test("the index and the page list the latest version of each published listing", async () => {
  const index = marketplaceIndex(await readPublishedListings(siteReleaseTrust()));
  assert.deepEqual(json(join(MARKETPLACE_PATHS.public, "index.json")), {listings: index});
  const page = readFileSync(join(MARKETPLACE_PATHS.public, "index.html"), "utf8");
  assert.equal(stampMarketplacePage(page, index), page, "run: node scripts/marketplace/publish-listing.ts index");
});

test("each listing's sources are what its latest published version signed", async () => {
  const published = await readPublishedListings(siteReleaseTrust());
  const sources = join(MARKETPLACE_PATHS.sources, "listings");
  for (const listingId of readdirSync(sources)) {
    const latest = marketplaceIndex(published).find((entry) => entry.listingId === listingId);
    assert.ok(latest, `${listingId} has sources but is not published`);
    const bundle = json(join(MARKETPLACE_PATHS.public, "..", latest.bundle));
    const {contentDigest: _digest, ...signed} = bundle.listing.payload;
    assert.equal(canonicalJson(signed), canonicalJson(json(join(sources, listingId, "listing.json"))),
        `${listingId}/listing.json changed since it was signed: re-sign it with a new version`);
    const pack = published.find((p) => p.listing.listingId === listingId && p.listing.version === latest.version).content;
    assert.equal(canonicalJson(pack), canonicalJson(CurriculumPackContent.parse(json(join(sources, listingId, "pack.json")))),
        `${listingId}/pack.json changed since it was signed: re-sign it with a new version`);
  }
});

test("each bundle carries its publisher's published credential, and nothing published holds a private key", () => {
  for (const file of files(join(MARKETPLACE_PATHS.public, "listings"))) {
    const bundle = json(file);
    const publisherId = bundle.listing.payload.publisherId;
    assert.deepEqual(bundle.credential, json(join(MARKETPLACE_PATHS.public, "publishers", `${publisherId}.json`)), file);
  }
  for (const file of files(MARKETPLACE_PATHS.public)) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /"d"\s*:/, `${file} holds a private JWK`);
  }
});

test("the publish script refuses to issue a credential no district pinning the site's keys would accept", async () => {
  const stranger = await SigningIdentity.generate();
  const publisher = json(join(MARKETPLACE_PATHS.sources, "publishers", "educateos.json"));
  await assert.rejects(issueCredential(stranger, publisher, siteReleaseTrust()), /not a release key the site pins/);
});
