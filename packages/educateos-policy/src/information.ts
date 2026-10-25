import { z } from "zod";
import {
  roleAssignmentInForce,
  type DistrictDirectorySnapshot,
  type PolicySettings,
  type PrincipalFacts,
  type PrincipalId,
  type ResourceRef,
  type Scope,
} from "@educateos/contracts";
import type { AcademicStore } from "@educateos/academics";

/**
 * What the engine knows about a subject. It comes from the directory, never from the request. The
 * roles in force are the role assignments that still hold, plus one role at each offering the
 * principal is actively enrolled in.
 */
export interface SubjectFacts extends PrincipalFacts {
  /** The principal. */
  principalId: PrincipalId;
  /** Whether the principal's status is `active`. Only an active principal holds roles or relationships. */
  active: boolean;
}

/**
 * A relationship between a subject and one specific resource that a stored record establishes,
 * rather than a role at a scope:
 *
 * - `share-grantee`: the resource's owner shared it with the subject (a learning-artifacts
 *   `ShareGrant`).
 * - `appeal-reviewer`: an unexpired, unrevoked purpose-bound grant names the subject as reviewing
 *   this resource of this student (an {@link AppealAccessGrant}).
 * - `guardian-of`: a confirmed, in-force `GuardianRelationship` makes the subject a guardian of the
 *   student who owns the resource, or who is actively enrolled in the offering an unowned resource
 *   belongs to (ADR-0012, {@link guardianRelationships}).
 */
export const Relationship = z.enum(["share-grantee", "appeal-reviewer", "guardian-of"]);
/** A relationship. */
export type Relationship = z.infer<typeof Relationship>;

/** One relationship a record establishes, with that record's ID so the decision's audit entry can name it. */
export interface RelationshipFact {
  /** The relationship. */
  relationship: Relationship;
  /** The record that establishes it. */
  grantId: string;
}

/**
 * Where relationships come from: the service that keeps the records. It must read trusted stored
 * state only and answer for the exact resource (`kind`, `id`, scope and owner). A source whose
 * records name one resource (a share, an appeal grant) returns nothing for a resource with no
 * `id`; a source whose records relate the subject to a person (a guardian relationship) may also
 * answer for a `list` at a scope, since the request's owner and scope are what it checks.
 */
export interface RelationshipSource {
  /** The relationships `subject` holds to `resource`. */
  relationships(subject: PrincipalId, resource: ResourceRef): Promise<readonly RelationshipFact[]>;
}

/**
 * The policy information point: the only place the engine reads facts from. Implementations read
 * trusted server-side state (the academic directory, the configured policy floor) and nothing a
 * caller sent.
 */
export interface PolicyInformationPoint {
  /** The subject's facts, or `undefined` if the directory has no such principal. */
  subjectFacts(principalId: PrincipalId): Promise<SubjectFacts | undefined>;
  /** The effective policy floor at a resource's scope. */
  effectivePolicy(scope: Scope): Promise<PolicySettings>;
  /**
   * Whether the directory has the school and offering a scope names, with the offering in that
   * school. A scope built from caller input could otherwise name an offering under a school it
   * is not in, and so fall inside that school's grants.
   */
  scopeExists(scope: Scope): Promise<boolean>;
  /** The relationships `subject` holds to one resource. */
  relationships(subject: PrincipalId, resource: ResourceRef): Promise<readonly RelationshipFact[]>;
}

/** Where the effective policy floor for a scope comes from (the F03 configuration compiler). */
export interface PolicySource {
  /** The resolved policy in force at `scope`. */
  effectivePolicy(scope: Scope): Promise<PolicySettings>;
}

/**
 * The facts a directory holds about one principal.
 *
 * - Every active enrollment counts as its role (`student`, `teacher` or `co-teacher`) at that
 *   offering. An inactive one counts for nothing.
 * - A role assignment from the roster at offering level holds only while the principal has an
 *   active enrollment in that offering with the same role. Otherwise a teacher or student dropped
 *   by a roster sync would keep live access through a stale assignment (A01 open question).
 * - Local grants, and roster assignments at school or district level, hold as stored.
 * - A dated assignment holds only between its `validFrom` and `validUntil`, judged at `at`.
 * - A principal that is not `active` (inactive or graduated) holds none of them: its classroom and
 *   local grants end with its status, while its records and work are kept.
 * - A guardian holds none of them either: what a guardian may read comes only from guardian
 *   relationships (ADR-0012).
 */
export function subjectFactsFrom(
  snapshot: DistrictDirectorySnapshot,
  principalId: PrincipalId,
  at: Date = new Date(),
): SubjectFacts | undefined {
  const principal = snapshot.principals.find((p) => p.id === principalId);
  if (principal === undefined) return undefined;
  if (principal.status !== "active") return { principalId, districtId: principal.districtId, kind: principal.kind, active: false, roles: [] };
  // A guardian's authority is their relationships, never a role or enrollment (ADR-0012).
  if (principal.kind === "guardian") return { principalId, districtId: principal.districtId, kind: principal.kind, active: true, roles: [] };
  const active = snapshot.enrollments.filter((e) => e.principalId === principalId && e.status === "active");

  const roles = snapshot.roleAssignments.filter((assignment) => {
    const { principalId: holder, role, scope, source } = assignment;
    if (holder !== principalId || !roleAssignmentInForce(assignment, at)) return false;
    if (source !== "roster" || scope.level !== "offering") return true;
    return active.some((e) => e.offeringId === scope.offeringId && e.role === role);
  });
  for (const enrollment of active) {
    const offering = snapshot.offerings.find((o) => o.id === enrollment.offeringId);
    if (offering === undefined) continue;
    roles.push({
      principalId,
      role: enrollment.role,
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      source: "roster",
    });
  }
  return { principalId, districtId: principal.districtId, kind: principal.kind, active: true, roles };
}

/** Whether `snapshot` has the school and offering `scope` names, with the offering in that school. */
export function scopeExistsIn(snapshot: DistrictDirectorySnapshot, scope: Scope): boolean {
  if (scope.districtId !== snapshot.district.id) return false;
  if (scope.level === "district") return true;
  if (!snapshot.schools.some((school) => school.id === scope.schoolId)) return false;
  if (scope.level === "school") return true;
  return snapshot.offerings.some((offering) => offering.id === scope.offeringId && offering.schoolId === scope.schoolId);
}

/** What {@link directoryPolicyInformation} reads besides the directory and the policy floor. */
export interface DirectoryPolicyInformationOptions {
  /** The services whose records establish relationships, such as artifact shares, appeal and guardian grants. */
  relationships?: readonly RelationshipSource[];
  /** The clock dated role assignments are judged by. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * A {@link PolicyInformationPoint} over an academic store, reading the current directory on every
 * lookup so a deactivated enrollment, an expired role or a revoked grant takes effect on the next
 * decision. Every relationship source is asked; each decides which resources its records can name.
 */
export function directoryPolicyInformation(
  store: AcademicStore,
  policy: PolicySource,
  options: DirectoryPolicyInformationOptions = {},
): PolicyInformationPoint {
  const sources = options.relationships ?? [];
  const now = options.now ?? (() => new Date());
  return {
    async subjectFacts(principalId) {
      return subjectFactsFrom((await store.load()).snapshot, principalId, now());
    },
    effectivePolicy: (scope) => policy.effectivePolicy(scope),
    async scopeExists(scope) {
      return scopeExistsIn((await store.load()).snapshot, scope);
    },
    async relationships(subject, resource) {
      return (await Promise.all(sources.map((source) => source.relationships(subject, resource)))).flat();
    },
  };
}
