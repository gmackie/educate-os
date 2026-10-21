import type { WorkerEntrypoint } from "cloudflare:workers";

/** The verified Cloudflare Access claims the backend passes to a {@link PrincipalResolver}. */
export type AccessSignIn = {
  /** The verified `iss`: the Access team domain, exactly as the token carried it. */
  issuer: string;
  /** The verified `sub`: the Access user ID. Never empty. */
  subject: string;
  /**
   * The token's `email`, when it has one. It identifies no one: a resolver may read it only to
   * find an email-keyed user awaiting adoption, which can only refuse the sign-in.
   */
  email?: string;
};

/** What a {@link PrincipalResolver} decided about one sign-in. */
export type PrincipalResolution =
  /**
   * The sign-in is the principal `principalId`, which is unique within the deployment and matches
   * `[A-Za-z0-9_-]{1,128}`. `displayName` seeds the profile of an account created by this sign-in.
   */
  | { outcome: "resolved"; principalId: string; displayName: string }
  /** The sign-in is linked to no principal. */
  | { outcome: "unauthenticated" }
  /**
   * The sign-in is linked to no principal yet, but an existing email-keyed user is waiting for an
   * administrator to confirm its adoption. Until then the sign-in is refused.
   */
  | { outcome: "adoption-pending" };

/**
 * An optional deployment-provided service, bound to the backend as `PRINCIPAL_RESOLVER`, that maps
 * a verified Cloudflare Access sign-in to a principal. When it is bound, the user Durable Object
 * is named for the principal rather than the email, and every other sign-in (session tokens,
 * passwords, authentication gatekeepers) is refused, since none of them carries an issuer and
 * subject to resolve. When it is not bound, sign-in keys users by email as before.
 */
export interface PrincipalResolver extends WorkerEntrypoint {
  /** Resolves one sign-in. A rejection refuses it: a configured resolver is mandatory. */
  resolveAccessSignIn(signIn: AccessSignIn): Promise<PrincipalResolution>;
}
