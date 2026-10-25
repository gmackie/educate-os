import {
  precheckAuthorization,
  roleAssignmentInForce,
  scopeContains,
  type Authorizer,
  type Decision,
  type DistrictDirectorySnapshot,
  type PrincipalFacts,
  type PrincipalId,
} from "@educateos/contracts";
import type { AcademicStore } from "./store.ts";

/** Looks up {@link PrincipalFacts} for a verified subject. */
export interface PrincipalFactsSource {
  /** The facts for a principal, or `undefined` if the directory has no such principal. */
  principalFacts(principalId: PrincipalId): Promise<PrincipalFacts | undefined>;
}

/**
 * The facts a directory holds about one principal. An active teacher or co-teacher enrollment
 * counts as that role at the offering, so a teacher enrolled through the fallback service can read
 * the roster without a separate grant; an inactive one counts for nothing. A dated role assignment
 * counts only while in force at `at`, and a guardian holds no roles (ADR-0012).
 */
export function principalFactsFrom(
  snapshot: DistrictDirectorySnapshot,
  principalId: PrincipalId,
  at: Date = new Date(),
): PrincipalFacts | undefined {
  const principal = snapshot.principals.find((p) => p.id === principalId);
  if (principal === undefined) return undefined;
  if (principal.status !== "active" || principal.kind === "guardian") return { districtId: principal.districtId, kind: principal.kind, roles: [] };
  const roles = snapshot.roleAssignments.filter((assignment) => assignment.principalId === principalId && roleAssignmentInForce(assignment, at));
  for (const enrollment of snapshot.enrollments) {
    if (enrollment.principalId !== principalId || enrollment.status !== "active" || enrollment.role === "student") {
      continue;
    }
    const offering = snapshot.offerings.find((o) => o.id === enrollment.offeringId);
    if (offering === undefined) continue;
    roles.push({
      principalId,
      role: enrollment.role,
      scope: { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id },
      source: "roster",
    });
  }
  return { districtId: principal.districtId, kind: principal.kind, roles };
}

/** A {@link PrincipalFactsSource} that reads the current directory from a store on every lookup. */
export function storePrincipalFacts(store: AcademicStore): PrincipalFactsSource {
  return {
    async principalFacts(principalId) {
      return principalFactsFrom((await store.load()).snapshot, principalId);
    },
  };
}

/**
 * A deliberately small {@link Authorizer} for the A01 fallback service, until the A02 ABAC engine
 * replaces it. It allows exactly:
 *
 * - a district admin, anything within their district;
 * - a school admin, anything within their school;
 * - a teacher or co-teacher, listing the enrollments (the roster) of an offering they teach;
 * - a student, reading their own enrollments.
 *
 * Everything else is denied. Roles come from the directory, never from the request.
 */
export class RoleTableAuthorizer implements Authorizer {
  readonly #facts: PrincipalFactsSource;

  constructor(facts: PrincipalFactsSource) {
    this.#facts = facts;
  }

  async authorize(input: unknown): Promise<Decision> {
    const precheck = precheckAuthorization(input);
    if (!precheck.ok) return precheck.decision;
    const { subject, action, resource } = precheck.request;

    const facts = await this.#facts.principalFacts(subject.principalId);
    if (facts === undefined || facts.districtId !== subject.districtId) {
      return { effect: "deny", reason: "no-matching-grant" };
    }

    for (const { role, scope } of facts.roles) {
      if (!scopeContains(scope, resource.scope)) continue;
      if (role === "district-admin" || role === "school-admin") return { effect: "allow" };
      if (
        (role === "teacher" || role === "co-teacher")
        && action === "list"
        && resource.kind === "enrollment"
        && resource.id === undefined
        && resource.scope.level === "offering"
      ) {
        return { effect: "allow" };
      }
    }

    if (
      facts.kind === "student"
      && action === "read"
      && resource.kind === "enrollment"
      && resource.ownerPrincipalId === subject.principalId
    ) {
      return { effect: "allow" };
    }
    return { effect: "deny", reason: "no-matching-grant" };
  }
}
