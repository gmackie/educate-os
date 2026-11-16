// The EducateOS demo districts (SCHO-210): five separate installations of the district Worker, one
// per demo district slug, each at its managed default hostname `<slug>.educateos.io`. They run in
// the owner's account beside schoolos.gmac.io, which also holds the educateos.io zone, so each
// hostname is a plain Workers custom domain (ADR-0013 addendum A1). The sixth demo district,
// northfield, is the schoolos.gmac.io instance's own district (`aliases` in schoolos-gmac-io.ts),
// and is not repeated here.
//
// Each district is its own Worker, so its own Durable Object namespace and its own storage, behind
// its own Access application. Nothing is shared between them but the code and the account. Their
// `DISTRICT_CONFIG` and Access pair are secrets, each in its own ForgeGraph app
// (`educateos-<slug>`), since ForgeGraph's `syncSecrets` copies every secret of an app's stage onto
// each of its targets. See docs/educateos/runbooks/demo-districts.md.

import publisher from "../../curriculum/educateos.io/publisher.json" with { type: "json" };
import type { DemoDistrictDeployment } from "./production-config.ts";

/** The owner's account, which holds schoolos.gmac.io and the educateos.io zone. */
const OWNER_ACCOUNT = "c07a7e704db1808e1fff91bed2b1cd49";

/**
 * One origin per district (ADR-0014 D7, SCHO-259), on since the cutover
 * (docs/educateos/runbooks/one-origin-cutover.md, step 8): each demo district answers `/ai` itself
 * with an "AI isn't enabled at your school" page linking to Northfield, the one AI-enabled demo
 * district, and publishes its school manifest.
 */
export const DEMO_DISTRICTS_ONE_ORIGIN = true;

/** Northfield's Workshop, on its one origin: where the other demo districts' `/ai` page points. */
export const AI_DEMO_URL = "https://northfield.educateos.io/ai/";

/**
 * The release keys the demo districts verify marketplace listings against (SCHO-209): the project's
 * demo release keys, the same public halves the educateos.io guided install pins as `RELEASE_TRUST`
 * (sites/educateos-io/wrangler.jsonc). A marketplace publisher credential is signed by this release key.
 */
export const DEMO_MARKETPLACE_TRUST = JSON.stringify({
  root: { threshold: 1, keys: [{ keyId: "ed25519-ZcqIp-xFaMyAdLm9A_VLfM9gzi-04hir2JmHXqornqc", publicKey: "mUuoDdWb6ERTjC_o3SI4hYf6pdb7tElPlkoVqPxx24k" }] },
  keySetVersion: 0,
  keys: [{ keyId: "ed25519-Y5ayv_OFgjE5j_YaqCuiuNvx-H7_d6AVfSjTnQlIc58", publicKey: "LVFy9O5qtmgvCGs0uhfjF9Q3aJZ4cQhrYYyouuF6YKg" }],
});

/**
 * The OCS publishers whose signed course bundles the demo districts and schoolos.gmac.io import into
 * their course libraries (SCHO-331): educateos.io alone, with the public key committed in
 * curriculum/educateos.io/publisher.json, which signs the reference courses under curriculum/bundles.
 * Imported from that file, so a key rotation there regenerates every config that pins it.
 */
export const EDUCATEOS_COURSE_LIBRARY_TRUST = JSON.stringify({ localDomains: [], publishers: [publisher] });

/**
 * The showcase every demo district may seed (SCHO-326): `DEMO_SHOWCASE`, which their
 * `DISTRICT_CONFIG.demo.showcase` must name too (demo-district-config.ts). See demo-districts.md.
 */
export const DEMO_SHOWCASE = "northfield";

/**
 * The analytics service the demo districts' pages may send usage events to (SCHO-350): the district
 * Dataflare deployment (DATFLR-7, gmackie/glass-analytics `deployments/district`), project
 * `educateos-district`, which accepts events only from these districts' origins. Each district's
 * administrator must still turn product analytics on; it starts off. Never set for a customer
 * district until DATFLR-3's legal review is done.
 */
export const DEMO_PRODUCT_ANALYTICS = JSON.stringify({
  host: "https://glass-educateos-district.educateos-demo.workers.dev",
  project: "educateos-district",
});

/** The demo districts deployed as their own district Workers, in fixture order. */
export const DEMO_DISTRICT_DEPLOYMENTS: readonly DemoDistrictDeployment[] = [
  "riverbend", "prairie", "cedarvalley", "lakeshore", "harbor",
].map((slug) => ({
  slug,
  accountId: OWNER_ACCOUNT,
  hostname: `${slug}.educateos.io`,
  oneOrigin: { enabled: DEMO_DISTRICTS_ONE_ORIGIN, aiDemoUrl: AI_DEMO_URL },
  marketplaceTrust: DEMO_MARKETPLACE_TRUST,
  courseLibraryTrust: EDUCATEOS_COURSE_LIBRARY_TRUST,
  showcase: DEMO_SHOWCASE,
  productAnalytics: DEMO_PRODUCT_ANALYTICS,
}));
