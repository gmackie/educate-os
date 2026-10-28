// The kernel side of the optional principal resolver (`PRINCIPAL_RESOLVER`, see
// @gadgets/workshop-shared/principal-resolver): with it bound, a verified Access sign-in names its
// user Durable Object for the principal the resolver returns, never for the token's email.

import type { JWTPayload } from "jose";
import { AUTH_ERROR_CODES, createAuthError } from "@gadgets/workshop-shared/api";
import type { PrincipalResolver } from "@gadgets/workshop-shared/principal-resolver";
import { createWorkshopLogger } from "../observability.js";

const logger = createWorkshopLogger("workshop.principal-sign-in");

/**
 * What a sign-in is refused with when the resolver (the district) cannot answer. Not an auth error:
 * the sign-in itself may be fine, and trying again later can succeed.
 */
export const PRINCIPAL_RESOLVER_UNAVAILABLE_MESSAGE =
    "Your school's directory can't be reached to sign you in right now. Try again in a few minutes.";

/** The resolver method the kernel calls. */
export type PrincipalResolverClient = Pick<PrincipalResolver, "resolveAccessSignIn">;

/**
 * Prefixes the name of a user Durable Object addressed by principal. Emails contain `@` and
 * password usernames are `[a-z][a-z0-9_]*`, so neither can name one of these. The `:` also makes
 * a `<name>:<secret>` session token for one unparseable, so none can be redeemed.
 */
export const PRINCIPAL_USER_PREFIX = "principal:";

const PRINCIPAL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Resolves a verified Access payload to the user Durable Object name and initial display name it
 * signs in as. Reads only `iss` and `sub`, plus `email` as the resolver's adoption hint. Throws a
 * coded auth error unless the resolver returns a well-formed principal.
 */
export async function resolvePrincipalUser(resolver: PrincipalResolverClient, payload: JWTPayload)
    : Promise<{ name: string; displayName: string }> {
  let { iss, sub, email } = payload;
  if (typeof iss !== "string" || typeof sub !== "string" || sub.length === 0) {
    throw createAuthError(AUTH_ERROR_CODES.principalUnresolved);
  }
  let resolution;
  try {
    resolution = await resolver.resolveAccessSignIn({
      issuer: iss,
      subject: sub,
      ...(typeof email === "string" && email.length > 0 ? { email } : {}),
    });
  } catch (error) {
    // Never falls back to email: an unreachable district refuses every sign-in until it is back.
    logger.error("the principal resolver failed", { event: "principal.resolve.failed", error });
    throw new Error(PRINCIPAL_RESOLVER_UNAVAILABLE_MESSAGE, { cause: error });
  }
  if (resolution.outcome === "adoption-pending") {
    throw createAuthError(AUTH_ERROR_CODES.principalAdoptionPending);
  }
  if (resolution.outcome !== "resolved" || !PRINCIPAL_ID.test(resolution.principalId)) {
    throw createAuthError(AUTH_ERROR_CODES.principalUnresolved);
  }
  return {
    name: PRINCIPAL_USER_PREFIX + resolution.principalId,
    displayName: resolution.displayName,
  };
}
