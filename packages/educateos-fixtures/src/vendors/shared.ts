// Helpers the vendor seeds share. Every vendor ID is derived from a fixture ID, so a seed is the
// same on every run and a vendor record can always be traced back to the fixture it came from.
import type { CatalogCourse, CourseOffering, DistrictDirectorySnapshot, GradeBand, Principal } from "@educateos/contracts";

/** The `dateLastModified` (and creation time) of every seeded vendor record. */
export const SEEDED_AT = "2026-08-17T15:00:00.000Z";

function fnv1a(text: string, round: number): number {
  let hash = (0x811c9dc5 ^ round) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A stable lowercase hex string of `length` characters derived from `key`, such as a Clever ID. */
export function stableHex(key: string, length: number): string {
  let out = "";
  for (let round = 0; out.length < length; round++) out += fnv1a(key, round).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

/** A stable string of `length` decimal digits, not starting with 0, derived from `key`. */
export function stableDigits(key: string, length: number): string {
  let out = "";
  for (let round = 0; out.length < length; round++) out += String(fnv1a(key, round)).padStart(10, "0");
  return `${1 + (fnv1a(key, 99) % 9)}${out.slice(1, length)}`;
}

/** A display name split the way rosters store it: the first word, then the rest. */
export function splitName(displayName: string): { first: string; last: string } {
  const [first, ...rest] = displayName.split(" ");
  return { first: first!, last: rest.join(" ") || first! };
}

/** The grades a band covers, as `K`, `1` ... `12`. */
export function gradesOf(band: GradeBand): string[] {
  const [low, high = low] = band.split("-") as [string, string?];
  const from = low === "K" ? 0 : Number(low);
  const to = high === "K" ? 0 : Number(high);
  return Array.from({ length: to - from + 1 }, (_, i) => (from + i === 0 ? "K" : String(from + i)));
}

/** The body of a fixture ID, without its kind prefix: `hb-teacher-asante` for `prn_hb-teacher-asante`. */
export function idBody(id: string): string {
  return id.slice(id.indexOf("_") + 1);
}

/** A principal's IdP subject: the vendor user ID for vendors whose sign-in is also the roster. */
export function subjectOf(principal: Principal): string {
  return principal.externalIdentities[0]!.subject;
}

/** Lookups every seed needs. */
export function indexDirectory(directory: DistrictDirectorySnapshot) {
  // Keyed by plain strings, since vendor records refer to fixture IDs without their brands.
  const course = new Map<string, CatalogCourse>(directory.courses.map((c) => [c.id, c]));
  const offering = new Map<string, CourseOffering>(directory.offerings.map((o) => [o.id, o]));
  const principal = new Map<string, Principal>(directory.principals.map((p) => [p.id, p]));
  /** The schools a principal is enrolled at or holds a scoped role in, in directory order. */
  const schoolsOf = (principalId: string): string[] => {
    const ids = new Set<string>();
    for (const e of directory.enrollments) if (e.principalId === principalId) ids.add(offering.get(e.offeringId)!.schoolId);
    for (const r of directory.roleAssignments) if (r.principalId === principalId && r.scope.level !== "district") ids.add(r.scope.schoolId);
    return directory.schools.map((s) => s.id).filter((id) => ids.has(id));
  };
  /** A student's grade: the lowest grade of the first course they are enrolled in. */
  const gradeOf = (principalId: string): string | undefined => {
    const first = directory.enrollments.find((e) => e.principalId === principalId);
    return first === undefined ? undefined : gradesOf(course.get(offering.get(first.offeringId)!.courseId)!.gradeBand)[0];
  };
  return { course, offering, principal, schoolsOf, gradeOf };
}
