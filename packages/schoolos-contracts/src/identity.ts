import { z } from "zod";
import { DistrictId, PrincipalId } from "./ids.ts";
import { ProviderName, UtcTimestamp } from "./primitives.ts";
import { Scope } from "./scope.ts";

/**
 * An identity asserted by a trusted issuer (an IdP, Cloudflare Access, an LTI platform). It is a
 * *link* to a principal, never the principal itself: one principal may hold several, and a link
 * is only trusted for the district that configured its issuer.
 *
 * The key is `(districtId, issuer, subject)`. Email is deliberately absent: it is reassigned,
 * recycled and edited by users, so keying on it can merge two people into one principal. See
 * ADR-0003.
 */
export const ExternalIdentity = z.strictObject({
  districtId: DistrictId,
  /** The issuer exactly as it appears in verified tokens (`iss`), e.g. an Access team domain. */
  issuer: z.url({ protocol: /^https$/ }),
  /** The issuer's stable subject (`sub`). Opaque; never parsed. */
  subject: z.string().min(1).max(255),
});
/** A link from a trusted issuer's subject to a principal. */
export type ExternalIdentity = z.infer<typeof ExternalIdentity>;

/**
 * The lookup key for an {@link ExternalIdentity}. It is the JSON encoding of the tuple, so no
 * choice of issuer or subject can collide with another (a delimiter-joined string could:
 * `a|b` + `c` and `a` + `b|c`).
 */
export function externalIdentityKey(identity: ExternalIdentity): string {
  return JSON.stringify([identity.districtId, identity.issuer, identity.subject]);
}

/**
 * What a principal is. This is not a role: a staff member may teach one offering and not another.
 *
 * A `guardian` (a parent or other caregiver) is neither staff nor student. A guardian holds no
 * roles and no enrollments; everything they may read comes from `GuardianRelationship` records an
 * administrator confirmed, one per student (ADR-0012).
 */
export const PrincipalKind = z.enum(["student", "staff", "guardian", "service"]);
/** A principal kind. */
export type PrincipalKind = z.infer<typeof PrincipalKind>;

/**
 * Where a principal is in its life. Only an `active` principal holds roles: an `inactive` one (a
 * roster dropped them) or a `graduated` one keeps its identity, workspaces and work for retention,
 * but no grant reaches it (roadmap §14, "Semester end / graduation"). No status deletes anything.
 */
export const PrincipalStatus = z.enum(["active", "inactive", "graduated"]);
/** A principal status. */
export type PrincipalStatus = z.infer<typeof PrincipalStatus>;

/** A person or service that can be authenticated in a district and then authorized. */
export const Principal = z.strictObject({
  id: PrincipalId,
  districtId: DistrictId,
  kind: PrincipalKind,
  status: PrincipalStatus,
  displayName: z.string().min(1).max(200),
  /**
   * Profile metadata for display and notifications only. Never an authentication or lookup key,
   * and not required to be unique.
   */
  email: z.email().optional(),
  externalIdentities: z.array(ExternalIdentity).min(1),
});
/** A district principal. */
export type Principal = z.infer<typeof Principal>;

/**
 * What kind of credential proved an identity. A person signs in through an IdP; a service presents
 * a machine credential such as an Access service token. The two never resolve to each other's
 * principals, so a leaked service credential cannot act as a person and a person's sign-in cannot
 * pick up a service's grants.
 */
export const CredentialKind = z.enum(["person", "service"]);
/** A credential kind. */
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * The only facts a principal resolver accepts from a token whose signature, issuer, audience and
 * expiry a verifier has already checked. Everything else a token carries (email, name, roles,
 * groups) is deliberately absent: it is not trusted for identity or authorization (ADR-0003).
 */
export const VerifiedIdentity = z.strictObject({
  /** The verified `iss`, exactly as the token carried it. */
  issuer: ExternalIdentity.shape.issuer,
  /** The verified stable subject. Opaque; never parsed or compared case-insensitively. */
  subject: ExternalIdentity.shape.subject,
  /** Which kind of credential produced the identity. */
  credential: CredentialKind,
});
/** A verified identity. */
export type VerifiedIdentity = z.infer<typeof VerifiedIdentity>;

/**
 * Identifies an existing Workshop user: the string form of its `UserDurableObject` ID, which the
 * kernel derives today from `idFromName(email)`. Opaque here. It is not a principal ID and never
 * becomes one; migration only links a Workshop user to a principal once an administrator confirms.
 */
export const WorkshopUserId = z.string().regex(/^[0-9a-f]{1,128}$/, "expected a Workshop user Durable Object ID").brand<"workshopUser">();
/** A Workshop user identifier. */
export type WorkshopUserId = z.infer<typeof WorkshopUserId>;

/**
 * Links a SchoolOS record to the record an external roster or platform (OneRoster, an LTI
 * platform's NRPS) holds for it. It is provenance, not identity: a person is found only through
 * an {@link ExternalIdentity}, and a source link never authenticates or authorizes anyone.
 */
export const SourceLink = z.strictObject({
  /** The external system, as named in the district's authority map (`external:<system>`). */
  system: ProviderName,
  /** The system's own identifier for the record (a OneRoster `sourcedId`). Opaque; never parsed. */
  sourcedId: z.string().min(1).max(255),
  /** When an applied sync last saw the system list the record. */
  lastSeenAt: UtcTimestamp,
});
/** A source link. */
export type SourceLink = z.infer<typeof SourceLink>;

/**
 * Roles a principal can hold at a scope. Holding a role never grants anything on its own; the
 * policy engine (A02) decides what each role may do at each scope, and denies by default.
 */
export const SchoolRole = z.enum([
  "district-admin",
  "school-admin",
  "curriculum-admin",
  "teacher",
  "co-teacher",
  "student",
]);
/** A school role. */
export type SchoolRole = z.infer<typeof SchoolRole>;

/**
 * A role held by a principal at a scope, with where the assignment came from. Roles projected from
 * a roster are replaced on sync; locally granted ones are not.
 *
 * An assignment may be dated, such as a substitute teacher's cover for two weeks. The dates are
 * enforced when each decision is made ({@link roleAssignmentInForce}), not by a job that removes
 * the assignment, so an expired assignment stops granting anything at once and stays on record.
 * `checkDirectoryIntegrity` refuses one whose `validFrom` is not before its `validUntil` (ADR-0012).
 */
export const RoleAssignment = z.strictObject({
  principalId: PrincipalId,
  role: SchoolRole,
  scope: Scope,
  source: z.enum(["roster", "local-grant"]),
  /** When the role starts to hold. Absent, it holds from when it was assigned. */
  validFrom: UtcTimestamp.optional(),
  /** When the role stops holding (exclusive). Absent, it holds until it is removed. */
  validUntil: UtcTimestamp.optional(),
});
/** A role assignment. */
export type RoleAssignment = z.infer<typeof RoleAssignment>;

/**
 * Whether a role assignment holds at `at`: on or after its `validFrom` and before its `validUntil`.
 * An undated assignment always holds; one whose dates are inverted never does.
 */
export function roleAssignmentInForce(assignment: Pick<RoleAssignment, "validFrom" | "validUntil">, at: Date): boolean {
  const time = at.getTime();
  if (assignment.validFrom !== undefined && time < Date.parse(assignment.validFrom)) return false;
  if (assignment.validUntil !== undefined && time >= Date.parse(assignment.validUntil)) return false;
  return true;
}
