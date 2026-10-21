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
 * What instructional staff may do to activities at a scope their assignment contains. A teacher's
 * assignments are offering-scoped, so a teacher authors, publishes and installs (`assign`) only in
 * offerings they teach. A co-teacher can see the class's activities but not change them.
 */
const STAFF_GRANTS: Readonly<Partial<Record<SchoolRole, readonly Action[]>>> = {
  teacher: ["create", "list", "read", "update", "publish", "assign"],
  "co-teacher": ["list", "read"],
};

/** What an actively enrolled student may do to an installed activity in their offering. */
const STUDENT_ACTIONS: readonly Action[] = ["list", "read"];

/** Whether `scope` names a school and offering the directory actually has. */
function scopeExists(directory: DistrictDirectorySnapshot, scope: Scope): boolean {
  if (scope.level === "district") return true;
  if (!directory.schools.some((school) => school.id === scope.schoolId)) return false;
  if (scope.level === "school") return true;
  return directory.offerings.some((offering) => offering.id === scope.offeringId && offering.schoolId === scope.schoolId);
}

/**
 * The curriculum service's authorization rules over a district directory, written to the A02
 * vocabulary so the district policy engine can adopt them. It decides only `activity` requests
 * and denies everything else, and runs {@link precheckAuthorization} first.
 *
 * - Staff hold {@link STAFF_GRANTS} through role assignments. Installing (`assign`) also needs the
 *   request to name a term that is planned or active.
 * - A student may read and list only `course`-classified activities (installed ones) in an
 *   offering where they hold an active student enrollment. Definitions are `teacher-only`, and an
 *   inactive enrollment reads nothing.
 */
export function curriculumAuthorizer(directory: DistrictDirectorySnapshot): Authorizer {
  return {
    async authorize(input: unknown): Promise<Decision> {
      const pre = precheckAuthorization(input);
      if (!pre.ok) return pre.decision;
      const { subject, action, resource, context } = pre.request;
      if (subject.districtId !== directory.district.id) return { effect: "deny", reason: "cross-district" };
      if (resource.kind !== "activity" || !scopeExists(directory, resource.scope)) {
        return { effect: "deny", reason: "no-matching-grant" };
      }
      const staff = directory.roleAssignments.some((assignment) =>
        assignment.principalId === subject.principalId
        && scopeContains(assignment.scope, resource.scope)
        && (STAFF_GRANTS[assignment.role] ?? []).includes(action));
      if (staff) {
        const termOpen = context.termState === "planned" || context.termState === "active";
        return action === "assign" && !termOpen ? { effect: "deny", reason: "term-not-active" } : { effect: "allow" };
      }
      const scope = resource.scope;
      const enrolled = "offeringId" in scope && directory.enrollments.some((enrollment) =>
        enrollment.principalId === subject.principalId
        && enrollment.offeringId === scope.offeringId
        && enrollment.role === "student"
        && enrollment.status === "active");
      if (enrolled && STUDENT_ACTIONS.includes(action)) {
        return resource.classification === "course" ? { effect: "allow" } : { effect: "deny", reason: "classification-restricted" };
      }
      return { effect: "deny", reason: "no-matching-grant" };
    },
  };
}
