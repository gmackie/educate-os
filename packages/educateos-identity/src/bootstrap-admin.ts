import { z } from "zod";
import {
  checkDirectoryIntegrity,
  externalIdentityKey,
  Principal,
  PrincipalId,
  type DistrictDirectorySnapshot,
  type VerifiedIdentity,
} from "@educateos/contracts";

/**
 * A district's first administrator, as the installer names them (SCHO-441).
 *
 * A new district cannot name its administrators' sign-in identities in advance: Cloudflare Access
 * mints a person's subject the first time they sign in, after the install has seeded the
 * directory. Without this the district's first administrator could never sign in, and nobody
 * could approve their link (ADR-0003 needs an administrator to approve one).
 *
 * So the deployment configuration may name bootstrap administrators who are not yet in the
 * directory. The first verified sign-in whose email equals one's `email` creates that principal,
 * with that identity and `district-admin` at district scope, in one directory change. The
 * installer's operator, who controls the Cloudflare account and its Access policy, named them:
 * that is the approval ADR-0003 asks for. Once the principal exists it is never bootstrapped
 * again, whatever later happens to it, so a principal always holds at least one identity and no
 * existing link is ever replaced.
 */
export const BootstrapAdmin = z.strictObject({
  /** The principal ID to create. Known in advance, so the installer can grant it Workshop roles. */
  principalId: PrincipalId,
  /** The administrator's name, for display. */
  displayName: Principal.shape.displayName,
  /** The email their first sign-in carries. Matched once, ignoring case and surrounding space. */
  email: z.email(),
});
/** A bootstrap administrator. */
export type BootstrapAdmin = z.infer<typeof BootstrapAdmin>;

/** One verified sign-in, offered to {@link bootstrapAdminLink}. */
export interface BootstrapAdminSignIn {
  /** The verified identity. */
  identity: VerifiedIdentity;
  /** The verified token's email, if it carries one. Never an identity on its own. */
  email: string | undefined;
  /** The bootstrap administrators the deployment configuration names. */
  bootstrapAdmins: readonly BootstrapAdmin[];
}

/** What linking a bootstrap administrator produces. */
export interface BootstrapAdminLink {
  /** The new directory snapshot. It passes `checkDirectoryIntegrity`. */
  directory: DistrictDirectorySnapshot;
  /** The principal that was created. */
  principalId: PrincipalId;
}

// As planEmailKeyedMigration matches emails.
const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Creates the bootstrap administrator whose email `signIn` carries, linked to its identity, when:
 * exactly one configured administrator has that email; no principal with that ID exists yet; the
 * identity is a person credential from an issuer the district trusts; and no one holds it.
 * Otherwise `undefined`, and the sign-in resolves (or is refused) as it would have. Pure: the
 * input directory is not modified.
 */
export function bootstrapAdminLink(directory: DistrictDirectorySnapshot, signIn: BootstrapAdminSignIn): BootstrapAdminLink | undefined {
  const { identity, email, bootstrapAdmins } = signIn;
  if (email === undefined || email.trim() === "" || bootstrapAdmins.length === 0) return undefined;
  if (identity.credential !== "person" || !directory.district.trustedIssuers.includes(identity.issuer)) return undefined;
  const wanted = normalizeEmail(email);
  const candidates = bootstrapAdmins.filter((admin) => normalizeEmail(admin.email) === wanted);
  // Two administrators sharing an email is ambiguous: create neither.
  if (candidates.length !== 1) return undefined;
  const admin = candidates[0]!;
  if (directory.principals.some((p) => p.id === admin.principalId)) return undefined;
  const districtId = directory.district.id;
  const link = { districtId, issuer: identity.issuer, subject: identity.subject };
  const key = externalIdentityKey(link);
  if (directory.principals.some((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key))) return undefined;
  const next: DistrictDirectorySnapshot = {
    ...directory,
    principals: [...directory.principals, {
      id: admin.principalId,
      districtId,
      kind: "staff",
      status: "active",
      displayName: admin.displayName,
      email: admin.email,
      externalIdentities: [link],
    }],
    roleAssignments: [...directory.roleAssignments, {
      principalId: admin.principalId,
      role: "district-admin",
      scope: { level: "district", districtId },
      source: "local-grant",
    }],
  };
  if (checkDirectoryIntegrity(next).length > 0) return undefined;
  return { directory: next, principalId: admin.principalId };
}
