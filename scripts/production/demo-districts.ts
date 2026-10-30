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

/** The demo districts deployed as their own district Workers, in fixture order. */
export const DEMO_DISTRICT_DEPLOYMENTS: readonly DemoDistrictDeployment[] = [
  "riverbend", "prairie", "cedarvalley", "lakeshore", "harbor",
].map((slug) => ({
  slug,
  accountId: OWNER_ACCOUNT,
  hostname: `${slug}.educateos.io`,
  oneOrigin: { enabled: DEMO_DISTRICTS_ONE_ORIGIN, aiDemoUrl: AI_DEMO_URL },
}));
