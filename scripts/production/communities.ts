// Community installations for home learning (ADR-0016): each its own install of the district
// Worker at `<slug>.educateos.io`, deployed exactly like a demo district (its own Worker, Durable
// Object, Access application and ForgeGraph app `educateos-<slug>`), but with no showcase, no
// marketplace or course library, and no product analytics: these hold real families' data.
// Their `DISTRICT_CONFIG` comes from packages/educateos-district-worker/scripts/community-config.ts.
// See docs/educateos/runbooks/community-instances.md.

import type { DemoDistrictDeployment } from "./production-config.ts";
import { AI_DEMO_URL } from "./demo-districts.ts";

/** The owner's account, which holds the educateos.io zone. */
const OWNER_ACCOUNT = "c07a7e704db1808e1fff91bed2b1cd49";

/** The community installations, in the order they were first deployed. */
export const COMMUNITY_DEPLOYMENTS: readonly DemoDistrictDeployment[] = [
  // The Safranek family (2026-11-15): one family's home learning.
  "safranek",
].map((slug) => ({
  slug,
  accountId: OWNER_ACCOUNT,
  hostname: `${slug}.educateos.io`,
  oneOrigin: { enabled: true, aiDemoUrl: AI_DEMO_URL },
}));
