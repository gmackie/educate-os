import { EducateOsError, VerifiedIdentity } from "@educateos/contracts";
import { identityFromCleverClaims, type CleverSsoConfig } from "./clever-sso.ts";

/**
 * The claims of a Cloudflare Access JWT *after* verification: what the kernel's
 * `verifyCfAccessJwt` (`packages/workshop-backend/src/access.ts`) returns once `jose` has checked
 * the signature against the team's certs, the issuer against `CF_ACCESS_ISS`, the audience against
 * `CF_ACCESS_AUD`, and the expiry. `jose`'s `JWTPayload` is assignable to it. This package never
 * verifies tokens itself, so never pass it an unverified payload.
 */
export type VerifiedAccessJwtPayload = Readonly<Record<string, unknown>>;

/** How a deployment's Cloudflare Access is configured. */
export interface CloudflareAccessConfig {
  /**
   * The Access team domain the deployment verifies against, the same value as the kernel's
   * `CF_ACCESS_ISS`: `https://<team>.cloudflareaccess.com`, no trailing slash. A district that
   * signs in through Access lists exactly this string in `trustedIssuers`.
   */
  readonly issuer: string;
  /**
   * Set when the deployment's Access application signs people in through Clever: an Access OIDC
   * login method for Clever that passes Clever's claims through, and no other login method for
   * people. Access does not say which login method a token came from, so a second method that
   * could pass a `user_type` claim could pose as Clever. See {@link identityFromAccessPayload}.
   */
  readonly clever?: CleverSsoConfig;
}

/**
 * Prefixes the subject of a service-token identity link. Access user subjects are UUIDs and never
 * start with it, and resolution additionally refuses to resolve a person credential to a service
 * principal, so a service-token link can never be matched by a person's sign-in.
 */
export const ACCESS_SERVICE_TOKEN_SUBJECT_PREFIX = "service-token:";

/**
 * The identity-link subject for an Access service token, given its `common_name` (the token's
 * client ID). An administrator links a `service` principal to
 * `{ districtId, issuer: <team domain>, subject: accessServiceTokenSubject(clientId) }`; without
 * that explicit link the token resolves to nothing.
 */
export function accessServiceTokenSubject(commonName: string): string {
  return `${ACCESS_SERVICE_TOKEN_SUBJECT_PREFIX}${commonName}`;
}

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Extracts the identity from a verified Access JWT payload. Only `iss`, `sub` and `common_name` are
 * read, and `custom` when `config.clever` is set.
 *
 * - **Issuer.** Access's `iss` is the team domain. It must equal `config.issuer` exactly; the
 *   verifier already required that, and it is checked again so this function is safe on its own.
 * - **Person.** A user token's subject is Access `sub`, the stable Access user ID. `email` is never
 *   used, so a reassigned, recycled or shared address cannot select a principal.
 * - **Service token.** A service-token JWT has `common_name` (the client ID) and no, or an empty,
 *   `sub`. It becomes a `service` credential whose subject is
 *   {@link accessServiceTokenSubject}, which resolves only through an explicit link to a `service`
 *   principal.
 * - **Clever.** With `config.clever` set, a user token whose `custom` claims (where Access puts the
 *   OIDC claims a login method passes through) carry Clever's `user_type` is a Clever sign-in: its
 *   identity is {@link identityFromCleverClaims}, under Clever's issuer, not Access's `sub`. Access
 *   keys its users by email, so a family sharing one address shares one Access `sub`; the Clever
 *   user ID tells them apart. A person's token without them is refused rather than read by its
 *   Access `sub`, which in a Clever district would be the shared, email-keyed identity. Service
 *   tokens are read as below.
 * - **Everything else is rejected:** a missing or empty `sub` without a `common_name`, a non-string
 *   claim, or a token carrying both a `sub` and a `common_name`, which Access never issues.
 *
 * Throws `EducateOsError("unauthenticated")` for every rejection.
 */
export function identityFromAccessPayload(
  payload: VerifiedAccessJwtPayload,
  config: CloudflareAccessConfig,
): VerifiedIdentity {
  const { iss, sub, common_name: commonName } = payload;
  if (typeof iss !== "string" || iss !== config.issuer) {
    throw new EducateOsError("unauthenticated", "The Access token was not issued by this deployment's team domain.");
  }
  if (sub !== undefined && typeof sub !== "string") {
    throw new EducateOsError("unauthenticated", "The Access token's subject is malformed.");
  }
  if (commonName !== undefined && typeof commonName !== "string") {
    throw new EducateOsError("unauthenticated", "The Access token's common name is malformed.");
  }

  let candidate: VerifiedIdentity;
  if (nonEmptyString(sub)) {
    if (nonEmptyString(commonName)) {
      throw new EducateOsError("unauthenticated", "The Access token names both a user and a service token.");
    }
    const custom = payload["custom"];
    if (config.clever !== undefined) {
      if (typeof custom !== "object" || custom === null || !("user_type" in custom)) {
        throw new EducateOsError("unauthenticated", "This district signs people in through Clever, and the Access token carries no Clever sign-in.");
      }
      return identityFromCleverClaims(custom as Readonly<Record<string, unknown>>, config.clever);
    }
    candidate = { issuer: iss, subject: sub, credential: "person" };
  } else if (nonEmptyString(commonName)) {
    candidate = { issuer: iss, subject: accessServiceTokenSubject(commonName), credential: "service" };
  } else {
    throw new EducateOsError("unauthenticated", "The Access token has no subject.");
  }

  const parsed = VerifiedIdentity.safeParse(candidate);
  if (!parsed.success) throw new EducateOsError("unauthenticated", "The Access token's identity is malformed.");
  return parsed.data;
}
