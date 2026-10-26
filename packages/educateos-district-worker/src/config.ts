// The district Worker's deployment configuration, read from the `DISTRICT_CONFIG` var (a JSON
// document) and validated strictly, so a malformed deployment fails closed rather than guessing.
// It holds what `DistrictAppOptions` takes from the deployment rather than from the district's
// stores. Everything administrators change later (configuration, funding allocations, the roster)
// is stored in the district's Durable Object, not here.
import { z } from "zod";
import { DistrictDirectorySnapshot, PrincipalId } from "@educateos/contracts";
import { AuthoritySetting } from "@educateos/district-app";
import { CloudflareAccountFacts, FundingPoolSet, GovernedModel, UsdNano } from "@educateos/ai-governance";
import { RetentionPolicy } from "@educateos/workspaces";

/** The district Worker's configuration. */
export const DistrictWorkerConfig = z.strictObject({
  /**
   * The directory the district's object is seeded with the first time it starts: the district
   * itself, and at least the administrators who will import the roster. Once the object holds a
   * directory this is ignored, apart from the district's ID, which must still match it.
   */
  directory: DistrictDirectorySnapshot,
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
