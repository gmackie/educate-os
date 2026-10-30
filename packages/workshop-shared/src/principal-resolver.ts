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

/** One existing email-keyed Workshop user, as the one-time principal migration describes it. */
export type EmailKeyedUser = {
  /** The email its user Durable Object is named from. */
  email: string;
  /** That Durable Object's ID, as hex. */
  workshopUserId: string;
};

/**
 * What the district's directory says about one {@link EmailKeyedUser}. Only `exact-single` names
 * a principal: exactly one person in the district has the email, and nobody else shares it.
 */
export type EmailKeyedUserMatch =
  | { email: string; outcome: "exact-single"; principalId: string }
  | { email: string; outcome: "ambiguous" | "cross-district" | "unmatched" };

/**
 * The directory side of the one-time migration of email-keyed users to principals (see
 * workshop-backend/src/auth/principal-aliases.ts). A district entrypoint that implements
 * {@link PrincipalResolver} implements this too, and the backend reaches it as
 * `PRINCIPAL_MIGRATION` (bound before the cutover, which changes no sign-in) or
 * `PRINCIPAL_RESOLVER`.
 */
export interface PrincipalMigrationDirectory extends WorkerEntrypoint {
  /** Matches existing users to the district's people by email. Proposes; links nothing. */
  matchEmailKeyedUsers(users: EmailKeyedUser[]): Promise<EmailKeyedUserMatch[]>;
}

/**
 * What the principal migration did, or would do, with one email-keyed user:
 *
 * - `alias`: its principal's user name now resolves (or, in a dry run, would resolve) to it.
 * - `already-aliased`: an earlier run made exactly this alias.
 * - `ambiguous`, `cross-district`, `unmatched`: the directory named no single principal for it.
 * - `conflict`: aliasing it would hide or share someone's data (see `reason`), so it was skipped.
 */
export type PrincipalMigrationOutcome =
  "alias" | "already-aliased" | "ambiguous" | "cross-district" | "unmatched" | "conflict";

/** One email-keyed user in a {@link PrincipalMigrationReport}. */
export type PrincipalMigrationEntry = {
  /** The user's name, the email its Durable Object is named from. */
  user: string;
  outcome: PrincipalMigrationOutcome;
  /** Its workspaces (the Workshop's threads), counted in its own Durable Object. */
  threads: number;
  /** The principal the directory matched it to, when it matched one. */
  principalId?: string;
  /** Why a `conflict` was skipped. */
  reason?: "principal-account-exists" | "principal-aliased-to-another-user" |
      "user-aliased-to-another-principal" | "principal-matched-twice" | "malformed-principal-id";
  /** After an applied run, its workspaces counted again through the principal's alias. */
  threadsViaPrincipal?: number;
};

/** The principal migration's report: counts first, then every user, sorted by name. */
export type PrincipalMigrationReport = {
  /** False for a dry run, which writes nothing. */
  applied: boolean;
  /** Email-keyed users found in the user directory. */
  users: number;
  /** Their workspaces, in total. */
  threads: number;
  counts: Record<PrincipalMigrationOutcome, number>;
  entries: PrincipalMigrationEntry[];
};
