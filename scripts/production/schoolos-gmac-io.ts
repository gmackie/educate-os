// The schoolos.gmac.io production instance (SCHO-192): one long-lived SchoolOS deployment on the
// gmacko Cloudflare account, deployed Worker by Worker by ForgeGraph from the configs
// production-config.ts generates. Everything here is non-secret: resource ids and names, the
// origin, and plain-text vars. Secrets (the backend's ADMINS and Cloudflare Access pair, the guard's
// Hall Monitor signing key, the district's DISTRICT_CONFIG and Access pair, the Google connector's
// OAuth client) are delivered by ForgeGraph and never written down here; see
// docs/schoolos/runbooks/production-instance.md.

import type { ProductionInstance } from "./production-config.ts";

/** The schoolos.gmac.io instance. */
export const SCHOOLOS_GMAC_IO: ProductionInstance = {
  hostname: "schoolos.gmac.io",
  accountId: "c07a7e704db1808e1fff91bed2b1cd49",
  // The three auto-provisioned gatekeepers, which need no OAuth app, and the Google connector
  // (SCHO-214), whose OAuth client is its CLIENT_ID and CLIENT_SECRET secrets.
  gatekeepers: [
    "gatekeeper-context", "gatekeeper-google", "gatekeeper-scheduler", "gatekeeper-websearch",
  ],
  kvNamespaces: {
    "workshop-backend": {
      BLUEPRINTS: "23044a01aab84a66b92f7c6bce327af8",
      AVATARS: "ca5c9f279799460b82e9c9b35c6e9c9f",
    },
    "gatekeeper-context": {
      CONTEXT_COLLECTIONS: "0fc6dfd326eb4bb7a7b41f729a6fd9de",
    },
  },
  r2Buckets: {
    "workshop-backend": {
      BLUEPRINT_CONTENT: "schoolos-prod-blueprint-content",
    },
  },
  vars: {
    // Server-managed Workers AI through the account's default AI Gateway, over the backend's
    // WORKERS_AI binding (same account, so no Run + Read token is needed).
    "workshop-backend": {
      CF_AI_GATEWAY: "default",
      CF_AI_GATEWAY_ACCOUNT_ID: "c07a7e704db1808e1fff91bed2b1cd49",
      CF_AI_GATEWAY_PROVIDERS: "cloudflare",
    },
    "gatekeeper-websearch": {
      CF_AI_GATEWAY: "default",
    },
    "schoolos-ai-guard": {
      HALL_MONITOR_ISSUER: "schoolos",
      HALL_MONITOR_AUDIENCE: "hall-monitor",
    },
  },
  aiGuard: {
    // The Hall Monitor Worker already deployed in the same account.
    hallMonitorService: "hall-monitor",
  },
  // LMS-lite (SCHO-193): the demo co-op district, behind its own Access application.
  district: {
    hostname: "district.schoolos.gmac.io",
  },
};
