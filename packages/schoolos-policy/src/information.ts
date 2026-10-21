import type {
  DistrictDirectorySnapshot,
  DistrictId,
  PolicySettings,
  PrincipalId,
  PrincipalKind,
  RoleAssignment,
  Scope,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";

/** What the engine knows about a subject. It comes from the directory, never from the request. */
export interface SubjectFacts {
  /** The principal. */
  principalId: PrincipalId;
  /** The principal's district. */
  districtId: DistrictId;
  /** Whether the principal is a student, staff member or service. */
  kind: PrincipalKind;
  /**
   * The roles in force: role assignments that still hold, plus one role at each offering the
   * principal is actively enrolled in.
   */
  roles: RoleAssignment[];
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
 */
export function subjectFactsFrom(
  snapshot: DistrictDirectorySnapshot,
  principalId: PrincipalId,
): SubjectFacts | undefined {
  const principal = snapshot.principals.find((p) => p.id === principalId);
  if (principal === undefined) return undefined;
  const active = snapshot.enrollments.filter((e) => e.principalId === principalId && e.status === "active");

  const roles = snapshot.roleAssignments.filter(({ principalId: holder, role, scope, source }) => {
    if (holder !== principalId) return false;
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
  return { principalId, districtId: principal.districtId, kind: principal.kind, roles };
}

/**
 * A {@link PolicyInformationPoint} over an academic store, reading the current directory on every
 * lookup so a deactivated enrollment or revoked grant takes effect on the next decision.
 */
export function directoryPolicyInformation(store: AcademicStore, policy: PolicySource): PolicyInformationPoint {
  return {
    async subjectFacts(principalId) {
      return subjectFactsFrom((await store.load()).snapshot, principalId);
    },
    effectivePolicy: (scope) => policy.effectivePolicy(scope),
  };
}
