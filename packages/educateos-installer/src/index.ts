// EducateOS district installer (roadmap R02, ADR-0001): installs a pinned release into a
// district-owned Cloudflare account, through the root's OAuth client or a district-run token, and
// reconciles desired against actual state. The Node-only release-directory reader is not exported
// here; import it from `./directory-artifacts.ts` in Node callers. The managed default hostname
// (`<slug>.educateos.io`) has a district half, in plan and apply, and an educateos.io half,
// `planManagedZone` and `applyManagedZone`.
export * from "./errors.ts";
export * from "./manifest.ts";
export * from "./config.ts";
export * from "./token.ts";
export * from "./oauth.ts";
export * from "./cloudflare-api.ts";
export * from "./cloudflare-http.ts";
export * from "./cloudflare-fake.ts";
export * from "./artifacts.ts";
export * from "./desired.ts";
export * from "./render.ts";
export * from "./plan.ts";
export * from "./apply.ts";
export * from "./preflight.ts";
export * from "./rollback.ts";
export * from "./fleet-registration.ts";
export * from "./installer.ts";
export * from "./drift.ts";
export * from "./slug.ts";
export * from "./managed-hostname.ts";
export * from "./managed-zone.ts";
