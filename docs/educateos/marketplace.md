# The EducateOS marketplace

- Status: free curriculum packs, in development (SCHO-209)
- Code: `packages/educateos-marketplace`, `scripts/marketplace/publish-listing.ts`, the district app's
  `admin.installMarketplacePack` (`packages/educateos-district-app/src/marketplace.ts`)
- Site: [educateos.io/marketplace/](https://educateos.io/marketplace/), from `sites/educateos-io/marketplace/`
  (sources) and `sites/educateos-io/public/marketplace/` (what is served)

The marketplace offers signed listings that a district installs and verifies offline, with no
runtime dependency on educateos.io ([ADR-0013](adr/0013-educateos-open-core-control-plane.md)
decisions 1 and 3). This pass offers free curriculum packs only.

## A listing

A listing is one JSON file in the `educateos.marketplace.listing/v1` format (`ListingBundle`). It
holds three parts:

| Part | Signed by | Says |
| --- | --- | --- |
| `credential` | An EducateOS release key, as release message kind `marketplace-publisher` | This key is publisher `educateos`'s listing key, from `issuedAt` until `expiresAt` |
| `listing` | The publisher's key, in the `educateos-marketplace/v1` context | Listing `middle-school-starter-pack` version `1.0.0`, under this licence and pricing, has content with this digest |
| `content` | Nobody; bound by the listing's `contentDigest` (SHA-256 of its canonical JSON) | The pack itself |

Before installing, the district checks the chain from the root down:

1. Its pinned root keys govern its release keys. This is the `ReleaseTrust` it already uses for
   releases ([release-signing.md](release-signing.md)).
2. A release key signed the publisher's credential.
3. The credential's key signed the listing.
4. The listing's digest names the content.

The message kind and context are part of the signed bytes, so a credential can never pass as a
release manifest, nor a listing as either.

**Pricing** is a discriminated union with only `{ "model": "free" }`. A district refuses any other
model with `conflict`, so adding a paid model later (delivered per purchase as its own signed file)
never makes an older district install something it can't handle. Nothing at runtime checks an
entitlement. A pack keeps working after its credential expires or a subscription lapses.

**A curriculum pack** (`CurriculumPackContent`) is a set of curriculum `TemplateInput`s. A pack is
self-contained, so its activities may not name resources, Codex resource entries, alignments or
rubrics, and may not be primary-source analyses: all of those live in the publisher's own registry.
Codex notes are allowed.

## Installing into a district

The district Worker pins its marketplace keys in the `MARKETPLACE_TRUST` var: public halves only, as
`ReleaseTrust` JSON. The demo districts pin the project's demo release keys, the same ones the
guided install pins (`DEMO_MARKETPLACE_TRUST` in `scripts/production/demo-districts.ts`). Without
the var, nothing installs.

A district administrator or district curriculum administrator downloads a listing from
educateos.io and posts it, as `application/json`, to `POST /api/admin/marketplace/packs`. The
request goes through the district's own sign-in, like every admin call.

- Installing a version already installed changes nothing.
- The same version with other content is refused (`conflict`).
- A newer version is installed beside the old one.

`GET /api/admin/marketplace/packs` lists what is installed. A class's teachers read the latest
version's templates at `GET /api/teacher/offerings/:offeringId/marketplace-packs` and create
activities from them through `teacher.createActivity`. No console page exists yet.

## Publishing

Two key holders sign, so there are two steps. Both keys are Ed25519 private JWKs read from the
environment. They are never written to disk or printed.

1. **Admit the publisher** (the release key holder). The publisher's public key goes in
   `sites/educateos-io/marketplace/publishers/<publisherId>.json`. Then:

   ```sh
   EDUCATEOS_RELEASE_SIGNING_KEY="$(security find-generic-password -s educateos-release-signing-key -w)" \
     node scripts/marketplace/publish-listing.ts credential educateos [--valid-days 365]
   ```

   This writes `public/marketplace/publishers/educateos.json`. It refuses a key that the site's
   `RELEASE_TRUST` doesn't pin.

2. **Sign a listing** (the publisher). Sources go in
   `sites/educateos-io/marketplace/listings/<listingId>/listing.json` (the statement without its
   digest) and `pack.json`. Then:

   ```sh
   EDUCATEOS_MARKETPLACE_PUBLISHER_KEY="$(security find-generic-password -s educateos-marketplace-publisher-key -w)" \
     node scripts/marketplace/publish-listing.ts listing middle-school-starter-pack
   ```

   This writes `public/marketplace/listings/<listingId>/<version>.json` and rebuilds `index.json`
   and the page's cards. Every bundle is verified against the site's pinned keys before it is
   written.

A published version is immutable. To change a pack, bump `version` in `listing.json` and sign
again. CI (`sites/educateos-io/marketplace.test.mjs`) fails when:

- a source differs from what its latest version signed,
- the index or page is stale,
- a bundle doesn't verify today. After a year this means the credential expired: issue a new one
  and re-sign.

The site Worker only serves the files, which ship with the site's normal deploy.

The EducateOS publisher key is in the owner's Keychain as `educateos-marketplace-publisher-key`.
Its public half is in `marketplace/publishers/educateos.json`.

## Not yet

- Paid listings and checkout.
- Blueprint and capability-pack listings.
- LTI tool listings, which wait until EducateOS can host LTI tools (IF-10).
- A revocation list for a publisher or listing. Today that takes rotating the release keys.
- A district console page that browses and installs listings.
