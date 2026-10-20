import { z } from "zod";
import { DistrictId, PrincipalId } from "./ids.ts";
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

/** What a principal is. This is not a role: a staff member may teach one offering and not another. */
export const PrincipalKind = z.enum(["student", "staff", "service"]);
/** A principal kind. */
export type PrincipalKind = z.infer<typeof PrincipalKind>;

/** A person or service that can be authenticated in a district and then authorized. */
export const Principal = z.strictObject({
  id: PrincipalId,
  districtId: DistrictId,
  kind: PrincipalKind,
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
 */
export const RoleAssignment = z.strictObject({
  principalId: PrincipalId,
  role: SchoolRole,
  scope: Scope,
  source: z.enum(["roster", "local-grant"]),
});
/** A role assignment. */
export type RoleAssignment = z.infer<typeof RoleAssignment>;
