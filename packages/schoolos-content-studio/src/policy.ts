import {
  type Action,
  type Authorizer,
  type Decision,
  type DistrictDirectorySnapshot,
  precheckAuthorization,
  type Scope,
  type SchoolRole,
  scopeContains,
} from "@schoolos/contracts";

/**
 * What each role may do to learning resources in the Content Studio, at a scope its assignment
 * contains. A teacher's assignments are offering-scoped, so a teacher acts on their own offering
 * only; district- and school-wide items need a curriculum admin. Widening an item's rights is
 * `configure`, which only a curriculum admin holds. Teachers bind releases to their own classes
 * with `assign`.
 */
const STUDIO_GRANTS: Readonly<Partial<Record<SchoolRole, readonly Action[]>>> = {
  teacher: ["create", "list", "read", "update", "approve", "publish", "assign"],
  "curriculum-admin": ["create", "list", "read", "update", "approve", "publish", "assign", "configure"],
};

/** Whether `scope` names a school and offering the directory actually has. */
function scopeExists(directory: DistrictDirectorySnapshot, scope: Scope): boolean {
  if (scope.level === "district") return true;
  if (!directory.schools.some((school) => school.id === scope.schoolId)) return false;
  if (scope.level === "school") return true;
  return directory.offerings.some((offering) => offering.id === scope.offeringId && offering.schoolId === scope.schoolId);
}

/**
 * The Content Studio's authorization rules over a district directory, written to the A02
 * vocabulary so the district policy engine can adopt them. It decides only `learning-resource`
 * requests and denies everything else, and runs {@link precheckAuthorization} first.
 */
export function contentStudioAuthorizer(directory: DistrictDirectorySnapshot): Authorizer {
  return {
    async authorize(input: unknown): Promise<Decision> {
      const pre = precheckAuthorization(input);
      if (!pre.ok) return pre.decision;
      const { subject, action, resource } = pre.request;
      if (subject.districtId !== directory.district.id) return { effect: "deny", reason: "cross-district" };
      if (resource.kind !== "learning-resource" || !scopeExists(directory, resource.scope)) {
        return { effect: "deny", reason: "no-matching-grant" };
      }
      const granted = directory.roleAssignments.some((assignment) =>
        assignment.principalId === subject.principalId
        && scopeContains(assignment.scope, resource.scope)
        && (STUDIO_GRANTS[assignment.role] ?? []).includes(action));
      return granted ? { effect: "allow" } : { effect: "deny", reason: "no-matching-grant" };
    },
  };
}
