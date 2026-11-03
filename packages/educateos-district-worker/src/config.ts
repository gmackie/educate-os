// The district Worker's deployment configuration, read from the `DISTRICT_CONFIG` var (a JSON
// document) and validated strictly, so a malformed deployment fails closed rather than guessing.
// It holds what `DistrictAppOptions` takes from the deployment rather than from the district's
// stores. Everything administrators change later (configuration, funding allocations, the roster)
// is stored in the district's Durable Object, not here.
import { z } from "zod";
import { WorkshopPolicySettings } from "./workshop-policy.ts";
import { googleclassroom } from "@educateos/integrations";
import { DistrictDirectorySnapshot, PrincipalId } from "@educateos/contracts";
import { AuthoritySetting } from "@educateos/district-app";
import { CloudflareAccountFacts, FundingPoolSet, GovernedModel, UsdNano } from "@educateos/ai-governance";
import { RetentionPolicy } from "@educateos/workspaces";
import { DiscussionScreeningSettings } from "@educateos/discussions";

const HttpsOrigin = z.url({ protocol: /^https$/ }).refine((value) => new URL(value).origin === value, "expected a bare https origin");

/**
 * The district's organization MCP endpoint (SCHO-174): `/mcp` as an OAuth protected resource for
 * one authorization server, with RFC 9728 metadata. Absent, the district serves neither.
 */
export const DistrictMcpSettings = z.strictObject({
  /** The district's public origin. The resource, and every token's only audience, is `<origin>/mcp`. */
  origin: HttpsOrigin,
  /**
   * The authorization server's issuer (Nathan, NATH-6), compared exactly with each token's `iss`.
   * The district must list it in `trustedIssuers` and link people's subjects under it.
   */
  issuer: z.url({ protocol: /^https$/ }).max(2048),
  /** Its JWKS URL, on the issuer's origin. Keys are fetched from here only, never from a token. */
  jwksUri: z.url({ protocol: /^https$/ }).max(2048),
  /** The asymmetric algorithms it signs access tokens with. */
  algorithms: z.array(z.enum(["RS256", "PS256", "ES256", "EdDSA"])).min(1),
  /** Exact browser origins allowed to call `/mcp`. Absent, only clients that send no Origin. */
  allowedOrigins: z.array(HttpsOrigin).max(30).optional(),
}).refine((mcp) => new URL(mcp.jwksUri).origin === new URL(mcp.issuer).origin, { message: "jwksUri must be on the issuer's origin", path: ["jwksUri"] });
/** The district's MCP endpoint settings. */
export type DistrictMcpSettings = z.infer<typeof DistrictMcpSettings>;

/** The district Worker's configuration. */
export const DistrictWorkerConfig = z.strictObject({
  /**
   * The directory the district's object is seeded with the first time it starts: the district
   * itself, and at least the administrators who will import the roster. Once the object holds a
   * directory this is ignored, apart from the district's ID, which must still match it.
   */
  directory: DistrictDirectorySnapshot,
  /** Explicit Workshop mint grants. Absent denies every capability request. */
  workshopPolicy: WorkshopPolicySettings.optional(),
  /**
   * Deployment-controlled issuers to add to an existing directory at startup. Existing trust
   * and identity links are preserved; removing this setting does not revoke persisted trust.
   * This does not change Access JWT verification or create identity links.
   */
  additionalTrustedIssuers: z.array(z.url({ protocol: /^https$/ })).min(1).max(100).optional(),
  /**
   * Which system owns each directory record type: `"oneroster"` (the default: the roster owns
   * every type), `"local"` (EducateOS owns every type, for a district with no roster, such as a
   * homeschool co-op, whose administrators build classes through the admin API), or a full
   * `AuthorityMap` for a mixed district.
   */
  authority: AuthoritySetting.optional(),
  /**
   * Clever SSO (SCHO-203): set when the district's Access application signs people in through an
   * OIDC login method for Clever that passes Clever's claims through. Such a sign-in is resolved as
   * the Clever user ID under `issuer` (Clever's own, `https://clever.com`, when absent), which the
   * district must list in `trustedIssuers` and its Clever roster's identity mapping must name. It
   * is deployment configuration, not a configuration revision, so an administrator's session
   * cannot change how people sign in.
   */
  cleverSso: z.strictObject({
    /** Clever's ID of the district. A sign-in from any other Clever district is refused. */
    districtId: z.string().regex(/^[0-9a-f]{24}$/),
    issuer: z.url({ protocol: /^https$/ }).optional(),
  }).optional(),
  /**
   * The service principal a scheduled roster sync acts as (SCHO-203) when it revokes the course
   * grants of people the roster dropped: a `service` principal in the directory with a district-admin
   * grant. Without it the hourly roster sync does not run; an administrator can still run one.
   */
  rosterServicePrincipalId: PrincipalId.optional(),
  /** Classroom DWD connection. The private key is a Worker secret, never configuration. */
  classroom: z.strictObject({
    /** Workspace administrator the roster reads act as. */
    admin: z.email(),
    /** Course selection, schools, term and allowed domains for this district. */
    roster: googleclassroom.ClassroomRosterConfig,
    /** Match the exact scopes delegated by the Workspace administrator. */
    rosterScopes: z.enum(["readonly", "read-write"]).default("readonly"),
  }).optional(),
  /** The district's AI funding pools. Defaults to none, so no AI request is funded. */
  fundingPools: FundingPoolSet.optional(),
  /** The district's monthly cap on its course and personal pools' allocations together. */
  aiMonthlyDistrictCapUsdNano: UsdNano.optional(),
  /** The Cloudflare account the district's AI usage is billed to, for the net cost estimate. */
  cloudflareAccount: CloudflareAccountFacts.optional(),
  /** The district gateway's model catalog. */
  modelCatalog: z.array(GovernedModel).optional(),
  /** Hosts students may save links to as external artifacts. */
  approvedExternalHosts: z.array(z.string().min(1).max(253)).max(100).optional(),
  /** How long course workspaces are kept after their term closes. */
  retention: RetentionPolicy.optional(),
  /**
   * Email (SCHO-189): notification and family digest email, sent through the Worker's own
   * `SEND_EMAIL` Cloudflare Email Service binding in the district's account. Absent, or without the
   * binding, nothing is emailed; in-app notifications work either way.
   */
  email: z.strictObject({
    /** The sender address: on a domain the district has onboarded to Email Service. */
    from: z.email().max(254),
    /** The sender's display name. */
    fromName: z.string().trim().min(1).max(100).regex(/^[^\r\n<>"]+$/, "no line breaks, angle brackets or quotes").optional(),
    /** The district's EducateOS address, linked from every email. */
    appUrl: z.url({ protocol: /^https$/ }).max(2048).optional(),
  }).optional(),
  /**
   * Discussions (SCHO-305): the Hall Monitor tenant, pinned policy profile and cost center student
   * posts are screened under. Hall Monitor is reached at `HALL_MONITOR_URL` with service tokens
   * signed by `HALL_MONITOR_SIGNING_KEY`; if either is missing, every student post is refused as
   * screening-unavailable rather than published unscreened.
   */
  discussionScreening: DiscussionScreeningSettings.optional(),
  /**
   * What happens to a student post when `discussionScreening` is absent: `"hold"` (the default)
   * keeps each for a teacher's approval; `"publish"` is for synthetic demo districts only.
   */
  unscreenedStudentPosts: z.enum(["hold", "publish"]).optional(),
  /**
   * The organization MCP endpoint (SCHO-174). Absent (the default), `/mcp` and its metadata are
   * 404. Turn it on only once the district's authorization server issues tokens for it (NATH-6)
   * and the Access application exempts `/mcp` and `/.well-known/oauth-protected-resource*`.
   */
  mcp: DistrictMcpSettings.optional(),
  /**
   * Demo districts only (SCHO-326): the showcase an administrator may seed and present
   * (`/api/demo/showcase/*`, see showcase.ts). It takes effect only when the Worker's committed
   * `DEMO_SHOWCASE` var names the same showcase, which only the demo deployments' generated configs
   * set, so neither this setting nor that var alone turns it on. Absent (every real district), those
   * routes are 404. Unlike `directory`, it is read on every start.
   */
  demo: z.strictObject({ showcase: z.enum(["northfield"]) }).optional(),
});
/** The district Worker's configuration. */
export type DistrictWorkerConfig = z.infer<typeof DistrictWorkerConfig>;

let cached: { text: string; config: DistrictWorkerConfig } | undefined;

/** Parses `DISTRICT_CONFIG`. The error names invalid fields only, never their values, which may be personal data. */
export function readDistrictWorkerConfig(text: string | undefined): DistrictWorkerConfig {
  if (text === undefined || text === "") throw new Error("DISTRICT_CONFIG is not set");
  if (cached?.text === text) return cached.config;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("DISTRICT_CONFIG is not JSON");
  }
  const parsed = DistrictWorkerConfig.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new Error(`DISTRICT_CONFIG is invalid at: ${fields.join(", ")}`);
  }
  cached = { text, config: parsed.data };
  return parsed.data;
}
