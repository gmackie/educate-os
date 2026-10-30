import { z } from "zod";
import { EducateOsError, type DistrictDirectorySnapshot, type PrincipalId, type VerifiedIdentity } from "@educateos/contracts";
import { identityFromAccessPayload, type CloudflareAccessConfig } from "./cloudflare-access.ts";
import { createDirectoryPrincipalResolver } from "./directory-resolver.ts";
import { requestIdentityLink, type PendingIdentityLink } from "./identity-linker.ts";
import { planEmailKeyedMigration, type MigrationPlan, type PendingWorkshopUserAdoption } from "./migration-plan.ts";

/**
 * One Access sign-in as the Workshop's principal resolver seam passes it: the shape of
 * `AccessSignIn` in `@gadgets/workshop-shared/principal-resolver`. The two are kept in step by
 * hand, because the kernel and EducateOS import nothing from each other (ADR-0002).
 */
export const AccessSignIn = z.strictObject({
  /** The verified `iss`. */
  issuer: z.string(),
  /** The verified `sub`. */
  subject: z.string(),
  /** The token's `email`: only a hint for finding a pending adoption, never an identity. */
  email: z.string().optional(),
});
/** An Access sign-in. */
export type AccessSignIn = z.infer<typeof AccessSignIn>;

/** What the seam expects back: the shape of the kernel's `PrincipalResolution`. */
export type AccessSignInResolution =
  | { outcome: "resolved"; principalId: PrincipalId; displayName: string }
  | { outcome: "unauthenticated" }
  | { outcome: "adoption-pending" };

/** The email-keyed migration a resolver takes part in, while a district adopts existing users. */
export interface AccessSignInMigration {
  /** The district's plan from `planEmailKeyedMigration`. Only its `exact-single` entries are used. */
  plan: MigrationPlan;
  /**
   * Stores a pending link for a district administrator to approve or reject. Until one approves
   * it, the sign-in keeps being refused. Approval alone does not adopt Workshop data: the
   * migration entry must remain pending until that data has been transferred and verified.
   */
  recordPendingLink(link: PendingIdentityLink): Promise<void>;
}

/** What {@link createAccessSignInResolver} resolves against. */
export interface AccessSignInResolverOptions {
  /** The district directory. Rebuild the resolver to pick up a changed one. */
  directory: DistrictDirectorySnapshot;
  /** The deployment's Cloudflare Access configuration. */
  access: CloudflareAccessConfig;
  /** The migration in progress, if any. Without one, an unlinked sign-in is simply refused. */
  migration?: AccessSignInMigration;
}

/** The Workshop principal resolver seam, implemented over a district directory. */
export interface AccessSignInResolver {
  /** Resolves one sign-in. Rejects only when the directory cannot answer. */
  resolveAccessSignIn(signIn: unknown): Promise<AccessSignInResolution>;
}

const UNAUTHENTICATED = { outcome: "unauthenticated" } as const;

const isUnauthenticated = (err: unknown) => err instanceof EducateOsError && err.code === "unauthenticated";

// As planEmailKeyedMigration matches emails, for finding candidates only.
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Implements the Workshop's principal resolver seam (`PRINCIPAL_RESOLVER`) for one district, over
 * `identityFromAccessPayload` and `createDirectoryPrincipalResolver`. A Worker entrypoint bound as
 * `PRINCIPAL_RESOLVER` delegates its `resolveAccessSignIn` here.
 *
 * - A sign-in whose `(issuer, subject)` is linked to an active person resolves to that principal,
 *   unless its Workshop data adoption is still pending. Email plays no part.
 * - An unlinked sign-in whose email matches an `exact-single` migration entry records a pending
 *   link through `migration.recordPendingLink` and answers `adoption-pending`. It is never linked
 *   here: a district administrator must approve the link.
 * - Everything else is `unauthenticated`: an untrusted issuer, a missing subject, an unlinked
 *   sign-in with no adoption waiting, a malformed request.
 *
 * Throws `EducateOsError("unavailable")` for a directory that fails its integrity checks and
 * `EducateOsError("validation-failed")` for a migration plan of another district.
 */
export function createAccessSignInResolver(options: AccessSignInResolverOptions): AccessSignInResolver {
  const { directory, access, migration } = options;
  const resolver = createDirectoryPrincipalResolver(directory);
  const displayNames = new Map(directory.principals.map((p) => [p.id, p.displayName]));
  if (migration !== undefined && migration.plan.districtId !== directory.district.id) {
    throw new EducateOsError("validation-failed", "The migration plan belongs to another district.");
  }
  const adoptions = new Map<string, PendingWorkshopUserAdoption>();
  const adoptingPrincipals = new Set<PrincipalId>();
  for (const entry of migration?.plan.entries ?? []) {
    if (entry.outcome === "exact-single") {
      adoptions.set(normalizeEmail(entry.email), entry.pendingAdoption);
      adoptingPrincipals.add(entry.pendingAdoption.principalId);
    }
  }

  return {
    async resolveAccessSignIn(signIn): Promise<AccessSignInResolution> {
      const parsed = AccessSignIn.safeParse(signIn);
      if (!parsed.success) return UNAUTHENTICATED;
      const { issuer, subject, email } = parsed.data;
      let identity: VerifiedIdentity | undefined;
      try {
        identity = identityFromAccessPayload({ iss: issuer, sub: subject }, access);
        const { principalId } = await resolver.resolve(identity);
        // Linking the identity is not adoption of the existing Workshop data. Keep the
        // principal blocked until the migration owner has transferred and verified that data
        // and removed its pending entry, even if the IdP email has changed or disappeared.
        if (adoptingPrincipals.has(principalId)) {
          return { outcome: "adoption-pending" };
        }
        return { outcome: "resolved", principalId, displayName: displayNames.get(principalId)! };
      } catch (err) {
        if (!isUnauthenticated(err)) throw err;
      }
      if (identity === undefined || email === undefined || migration === undefined) return UNAUTHENTICATED;

      const adoption = adoptions.get(normalizeEmail(email));
      if (adoption === undefined) return UNAUTHENTICATED;
      let link: PendingIdentityLink;
      try {
        link = requestIdentityLink(directory, {
          principalId: adoption.principalId,
          identity,
          requestedAt: new Date().toISOString(),
          workshopUserId: adoption.workshopUserId,
        });
      } catch (err) {
        // The identity cannot become this principal's link (an untrusted issuer, say): no adoption.
        if (err instanceof EducateOsError) return UNAUTHENTICATED;
        throw err;
      }
      await migration.recordPendingLink(link);
      return { outcome: "adoption-pending" };
    },
  };
}

/**
 * What the directory says about one email-keyed Workshop user, as the kernel's principal migration
 * asks (`EmailKeyedUserMatch` in `@gadgets/workshop-shared/principal-resolver`, kept in step by
 * hand). Only `exact-single` names a principal.
 */
export type EmailKeyedUserMatch =
  | { email: string; outcome: "exact-single"; principalId: PrincipalId }
  | { email: string; outcome: "ambiguous" | "cross-district" | "unmatched" };

/**
 * Matches the Workshop's existing email-keyed users to `directory`'s people, by
 * {@link planEmailKeyedMigration} with no other districts in view. Proposes, links nothing: the
 * kernel's migration aliases an `exact-single` user only when an administrator applies it.
 *
 * Throws `EducateOsError("validation-failed")` for a malformed or repeated user.
 */
export function matchEmailKeyedUsers(directory: DistrictDirectorySnapshot, users: unknown): EmailKeyedUserMatch[] {
  const plan = planEmailKeyedMigration({ directory, otherDirectories: [], users: Array.isArray(users) ? users : [users] });
  return plan.entries.map((entry): EmailKeyedUserMatch => entry.outcome === "exact-single"
    ? { email: entry.email, outcome: "exact-single", principalId: entry.pendingAdoption.principalId }
    : { email: entry.email, outcome: entry.outcome });
}
