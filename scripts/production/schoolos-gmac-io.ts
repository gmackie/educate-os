// The schoolos.gmac.io production instance (SCHO-192): one long-lived EducateOS deployment on the
// gmacko Cloudflare account, deployed Worker by Worker by ForgeGraph from the configs
// production-config.ts generates. Everything here is non-secret: resource ids and names, the
// origin, and plain-text vars. Secrets (the backend's ADMINS and Cloudflare Access pair, the guard's
// Hall Monitor signing key, the district's DISTRICT_CONFIG and Access pair, whose CF_ACCESS_AUD lists
// both the district's and the instance's Access audiences, the Google connector's OAuth client) are
// delivered by ForgeGraph and never written down here; see
// docs/educateos/runbooks/production-instance.md.

import type { ProductionInstance } from "./production-config.ts";

/** The schoolos.gmac.io instance. */
export const SCHOOLOS_GMAC_IO: ProductionInstance = {
  hostname: "schoolos.gmac.io",
  accountId: "c07a7e704db1808e1fff91bed2b1cd49",
  // The three auto-provisioned gatekeepers, which need no OAuth app; the Google connector
  // (SCHO-214), whose OAuth client is its CLIENT_ID and CLIENT_SECRET secrets; and the EducateOS
  // connector (SCHO-218), which needs no client: it is bound to the district below and verifies
  // people by the district's sign-in.
  gatekeepers: [
    "gatekeeper-context", "gatekeeper-google", "gatekeeper-scheduler", "gatekeeper-educateos",
    "gatekeeper-websearch",
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
    "educateos-ai-guard": {
      HALL_MONITOR_ISSUER: "educateos",
      HALL_MONITOR_AUDIENCE: "hall-monitor",
    },
  },
  aiGuard: {
    // The Hall Monitor Worker already deployed in the same account.
    hallMonitorService: "hall-monitor",
  },
  // LMS-lite (SCHO-193): the demo co-op district, behind its own Access application. Its
  // CF_ACCESS_AUD secret lists that application's audience and the instance's (SCHO-218).
  district: {
    hostname: "district.schoolos.gmac.io",
    // Its managed default hostname (SCHO-207). The educateos.io zone is in this account, so it is a
    // plain custom domain; both district Access applications list it as a second destination.
    aliases: ["northfield.educateos.io"],
  },
  // One origin per district (ADR-0014, SCHO-259): off until the cutover
  // (docs/educateos/runbooks/one-origin-cutover.md). On, the router serves northfield.educateos.io,
  // with the district at the root and the Workshop under /ai, and schoolos.gmac.io and
  // district.schoolos.gmac.io redirect there.
  oneOrigin: { enabled: false, hostname: "northfield.educateos.io" },
  // Cutover step 3 (SCHO-259): the backend binds the district's directory as PRINCIPAL_MIGRATION, so
  // an administrator can alias the email-keyed users to their principals. Sign-in is unchanged
  // until "resolver" binds PRINCIPAL_RESOLVER as well, in the flip.
  principalBinding: "migration",
  // Deployed before the EducateOS rename (SCHO-200), and pinned so it is never deployed under its
  // package's new name (SCHO-231). Its Durable Object holds the demo district's data, a Worker's
  // Durable Object namespace belongs to its name, and district.schoolos.gmac.io is attached to it:
  // under a new name the district would come up empty beside the old one. The AI call guard is
  // deliberately not pinned: it was already redeployed as educateos-ai-guard, with a fresh ledger,
  // which the demo's negligible guard usage allows; the old schoolos-ai-guard Worker is to be deleted.
  workerNames: {
    "educateos-district-worker": "schoolos-district-worker",
  },
};
