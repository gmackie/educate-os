// Clever SSO: the identity in a Clever sign-in's claims, so a district that signs in through Clever
// resolves people through `(district, issuer, subject)` with the Clever user ID as the subject, the
// same ID its Clever roster records (`clever.CLEVER_SUBJECT_FIELD` in @educateos/integrations).
// Claim names follow https://dev.clever.com/docs/oidc-implementation and Clever's discovery document
// (https://clever.com/.well-known/openid-configuration). New for EducateOS (SCHO-203).
import { EducateOsError, VerifiedIdentity } from "@educateos/contracts";

/** Clever's OIDC issuer: the `iss` of a Clever ID token. */
export const CLEVER_ISSUER = "https://clever.com";

/** Which Clever district a deployment's people sign in from. Holds no secret. */
export interface CleverSsoConfig {
  /**
   * Clever's ID of the district. Clever is one issuer for every district it serves, so a sign-in
   * is accepted only when its district claim names this one.
   */
  readonly districtId: string;
  /**
   * The issuer the district's identity links name for Clever sign-ins, which it must list in
   * `trustedIssuers` and its Clever roster's identity mapping must name too. {@link CLEVER_ISSUER}
   * when absent.
   */
  readonly issuer?: string;
}

/** The claims of a Clever sign-in, from a verified ID token or passed through by Cloudflare Access. */
export type CleverClaims = Readonly<Record<string, unknown>>;

const CLEVER_ID = /^[0-9a-f]{24}$/;

/**
 * Reads one claim that Clever spells two ways. Clever's ID tokens carry `district` while its
 * discovery document lists `district_id`, and userinfo carries both; the user's ID is `sub` in an
 * ID token and `multi_role_user_id` in its claims and userinfo. Both spellings are read, and when
 * both are present they must agree, so neither can be used to override the other.
 */
function either(claims: CleverClaims, names: readonly string[], what: string): string | undefined {
  const values = names.map((name) => claims[name]).filter((value) => value !== undefined);
  for (const value of values) {
    if (typeof value !== "string" || !CLEVER_ID.test(value)) {
      throw new EducateOsError("unauthenticated", `The Clever sign-in's ${what} is malformed.`);
    }
  }
  if (new Set(values).size > 1) throw new EducateOsError("unauthenticated", `The Clever sign-in names two different ${what}s.`);
  return values[0] as string | undefined;
}

/**
 * The identity a Clever sign-in asserts. The caller must already have verified the claims: they
 * come from a Clever ID token whose signature, audience and expiry were checked, or from a verified
 * Cloudflare Access token that passed Clever's claims through. This package never verifies tokens.
 *
 * - **District.** `district` or `district_id` must name {@link CleverSsoConfig.districtId}: a
 *   person from any other Clever district is refused, whoever they are.
 * - **Subject.** The Clever user ID: `multi_role_user_id` or `sub`. Failing both, a student's
 *   `user_id`, since a student's legacy ID is their user ID (Clever's multi-role docs). Anyone
 *   else's `user_id` is a per-role legacy ID that no roster records, so it is refused.
 * - **Email is never read**, so a family's shared address cannot select a principal.
 *
 * Throws `EducateOsError("unauthenticated")` for every rejection.
 */
export function identityFromCleverClaims(claims: CleverClaims, config: CleverSsoConfig): VerifiedIdentity {
  if (claims["iss"] !== undefined && claims["iss"] !== CLEVER_ISSUER) {
    throw new EducateOsError("unauthenticated", "The Clever sign-in was not issued by Clever.");
  }
  const district = either(claims, ["district", "district_id"], "district");
  if (district === undefined) throw new EducateOsError("unauthenticated", "The Clever sign-in names no district.");
  if (district !== config.districtId) throw new EducateOsError("unauthenticated", "The Clever sign-in is from another district.");

  let subject = either(claims, ["multi_role_user_id", "sub"], "user ID");
  if (subject === undefined && claims["user_type"] === "student") subject = either(claims, ["user_id"], "user ID");
  if (subject === undefined) throw new EducateOsError("unauthenticated", "The Clever sign-in carries no Clever user ID.");

  const parsed = VerifiedIdentity.safeParse({ issuer: config.issuer ?? CLEVER_ISSUER, subject, credential: "person" });
  if (!parsed.success) throw new EducateOsError("unauthenticated", "The Clever sign-in's identity is malformed.");
  return parsed.data;
}
