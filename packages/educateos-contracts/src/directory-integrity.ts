import type { DistrictDirectorySnapshot } from "./academic.ts";
import { externalIdentityKey } from "./identity.ts";
import type { Scope } from "./scope.ts";

/** One referential or tenancy problem in a directory snapshot. */
export interface DirectoryIssue {
  /** Where the problem is, e.g. `enrollments[3].offeringId`. */
  path: string;
  /** What is wrong. */
  message: string;
}

/**
 * The checks a parsed snapshot must pass before anything is applied from it, beyond what its
 * schema can say about one record at a time: every record belongs to the snapshot's district,
 * every reference resolves, no ID repeats, every identity comes from an issuer the district trusts
 * and no two principals share an identity link. A guardian principal holds no enrollment or role
 * (ADR-0012), and a dated role assignment ends after it starts. Roster imports (A03) refuse a snapshot with any
 * issue rather than applying the parts that look valid.
 */
export function checkDirectoryIntegrity(snapshot: DistrictDirectorySnapshot): DirectoryIssue[] {
  const issues: DirectoryIssue[] = [];
  const districtId = snapshot.district.id;
  const trusted = new Set(snapshot.district.trustedIssuers);

  const collections = {
    schools: snapshot.schools,
    terms: snapshot.terms,
    courses: snapshot.courses,
    offerings: snapshot.offerings,
    principals: snapshot.principals,
    enrollments: snapshot.enrollments,
  };
  const ids: Record<keyof typeof collections, Set<string>> = {
    schools: new Set(),
    terms: new Set(),
    courses: new Set(),
    offerings: new Set(),
    principals: new Set(),
    enrollments: new Set(),
  };
  for (const [name, records] of Object.entries(collections) as [keyof typeof collections, { id: string; districtId: string }[]][]) {
    records.forEach((record, i) => {
      if (record.districtId !== districtId) {
        issues.push({ path: `${name}[${i}].districtId`, message: `belongs to ${record.districtId}, not ${districtId}` });
      }
      if (ids[name].has(record.id)) {
        issues.push({ path: `${name}[${i}].id`, message: `duplicate ID ${record.id}` });
      }
      ids[name].add(record.id);
    });
  }

  const missing = (path: string, kind: string, id: string) =>
    issues.push({ path, message: `refers to unknown ${kind} ${id}` });

  snapshot.terms.forEach((term, i) => {
    if (term.startsOn > term.endsOn) issues.push({ path: `terms[${i}]`, message: "ends before it starts" });
  });

  const offeringSchool = new Map<string, string>();
  snapshot.offerings.forEach((offering, i) => {
    offeringSchool.set(offering.id, offering.schoolId);
    if (!ids.schools.has(offering.schoolId)) missing(`offerings[${i}].schoolId`, "school", offering.schoolId);
    if (!ids.terms.has(offering.termId)) missing(`offerings[${i}].termId`, "term", offering.termId);
    if (!ids.courses.has(offering.courseId)) missing(`offerings[${i}].courseId`, "course", offering.courseId);
  });

  const principalKind = new Map(snapshot.principals.map((p) => [p.id, p.kind]));
  const identityOwner = new Map<string, string>();
  snapshot.principals.forEach((principal, i) => {
    principal.externalIdentities.forEach((identity, j) => {
      const path = `principals[${i}].externalIdentities[${j}]`;
      if (identity.districtId !== districtId) {
        issues.push({ path, message: `identity is linked in ${identity.districtId}, not ${districtId}` });
      }
      if (!trusted.has(identity.issuer)) {
        issues.push({ path, message: `issuer ${identity.issuer} is not trusted by ${districtId}` });
      }
      const key = externalIdentityKey(identity);
      const owner = identityOwner.get(key);
      if (owner !== undefined && owner !== principal.id) {
        issues.push({ path, message: `identity is already linked to ${owner}` });
      }
      identityOwner.set(key, principal.id);
    });
  });

  snapshot.enrollments.forEach((enrollment, i) => {
    if (!ids.offerings.has(enrollment.offeringId)) {
      missing(`enrollments[${i}].offeringId`, "offering", enrollment.offeringId);
    }
    const kind = principalKind.get(enrollment.principalId);
    if (kind === undefined) {
      missing(`enrollments[${i}].principalId`, "principal", enrollment.principalId);
    } else if (kind === "guardian") {
      issues.push({ path: `enrollments[${i}].principalId`, message: "a guardian principal cannot enroll; a guardian relationship covers their child" });
    } else if ((enrollment.role === "student") !== (kind === "student")) {
      issues.push({ path: `enrollments[${i}].role`, message: `a ${kind} principal cannot enroll as ${enrollment.role}` });
    }
  });

  const checkScope = (path: string, scope: Scope) => {
    if (scope.districtId !== districtId) {
      issues.push({ path: `${path}.districtId`, message: `belongs to ${scope.districtId}, not ${districtId}` });
      return;
    }
    if (scope.level === "district") return;
    if (!ids.schools.has(scope.schoolId)) missing(`${path}.schoolId`, "school", scope.schoolId);
    if (scope.level === "school") return;
    const school = offeringSchool.get(scope.offeringId);
    if (school === undefined) missing(`${path}.offeringId`, "offering", scope.offeringId);
    else if (school !== scope.schoolId) {
      issues.push({ path: `${path}.offeringId`, message: `offering ${scope.offeringId} is not in school ${scope.schoolId}` });
    }
  };

  snapshot.roleAssignments.forEach((assignment, i) => {
    const kind = principalKind.get(assignment.principalId);
    if (kind === undefined) {
      missing(`roleAssignments[${i}].principalId`, "principal", assignment.principalId);
    } else if (kind === "guardian") {
      issues.push({ path: `roleAssignments[${i}].role`, message: "a guardian principal holds no roles; a guardian relationship covers their child" });
    }
    if (
      assignment.validFrom !== undefined && assignment.validUntil !== undefined
      && Date.parse(assignment.validUntil) <= Date.parse(assignment.validFrom)
    ) {
      issues.push({ path: `roleAssignments[${i}].validUntil`, message: "validUntil must be after validFrom" });
    }
    checkScope(`roleAssignments[${i}].scope`, assignment.scope);
  });

  return issues;
}
