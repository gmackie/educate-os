// The schoolos.gmac.io production instance (SCHO-192): one long-lived EducateOS deployment on the
// gmacko Cloudflare account, deployed Worker by Worker by ForgeGraph from the configs
// production-config.ts generates. Everything here is non-secret: resource ids and names, the
// origin, and plain-text vars. Secrets (the backend's ADMINS and Cloudflare Access pair, the guard's
// Hall Monitor signing key, the district's DISTRICT_CONFIG and Access pair, whose CF_ACCESS_AUD lists
// both the district's and the instance's Access audiences, the Google connector's OAuth client, the
// Clever connector's OAuth client and district tokens) are
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
  // people by the district's sign-in; and the Clever connector (SCHO-282), pointed at the demo's
  // Clever fake for Cedar Valley, whose OAuth client and district token are its CLIENT_ID,
  // CLIENT_SECRET and CLEVER_DISTRICT_TOKENS secrets.
  gatekeepers: [
    "gatekeeper-clever", "gatekeeper-context", "gatekeeper-google", "gatekeeper-scheduler",
    "gatekeeper-educateos", "gatekeeper-websearch",
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
    // The demo's Clever is the provider fake's Cedar Valley district (sites/educateos-demo-fakes),
    // which has no sign-in page, so the connector asks who to sign in as and passes it as login_hint.
    "gatekeeper-clever": {
      CLEVER_API_BASE: "https://fakes.demo.educateos.io/cedarvalley/clever",
      CLEVER_OAUTH_BASE: "https://fakes.demo.educateos.io/cedarvalley/clever",
      CLEVER_LOGIN_HINT_FORM: "true",
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
  // One origin per district (ADR-0014, SCHO-259), on since the cutover
  // (docs/educateos/runbooks/one-origin-cutover.md): the router serves northfield.educateos.io,
  // with the district at the root and the Workshop under /ai, and schoolos.gmac.io and
  // district.schoolos.gmac.io redirect there.
  oneOrigin: { enabled: true, hostname: "northfield.educateos.io" },
  // Workshop sign-in resolves the Access subject to a district principal (PRINCIPAL_RESOLVER); the
  // users the migration aliased keep their email-keyed accounts.
  principalBinding: "resolver",
  // Workshop mints and execution become the district's to allow, and a principal who loses
  // standing loses what they hold (SCHO-309), once this is on. It stays off until the district's
  // DISTRICT_CONFIG.workshopPolicy grants the demo's staff: without one the district denies every
  // mint and execution, and the district Worker answering principalStanding must deploy first.
  capabilityPolicyBinding: false,
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
