// Checks a district seed and answers the questions every fake asks of one.
import type { DistrictSeed, PersonRole, PersonSeed, SectionSeed, SeedRecord } from "./types.ts";

/** Thrown for a seed that breaks its own references or the `.example` rule. */
export class SeedError extends Error {
  override readonly name = "SeedError";
}

const EXAMPLE_HOST = /(^|\.)example$/i;

function exampleEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  return at > 0 && EXAMPLE_HOST.test(email.slice(at + 1));
}

/**
 * Checks that a seed is internally consistent (unique IDs, references that resolve, roles that fit
 * where they are used) and synthetic: every email and the district domain are on a reserved
 * `.example` domain. Returns the seed, so a fake can validate in its constructor.
 */
export function validateSeed(seed: DistrictSeed): DistrictSeed {
  const problems: string[] = [];
  if (!EXAMPLE_HOST.test(seed.domain)) problems.push(`domain ${seed.domain} is not a .example domain`);
  const ids = (what: string, records: readonly SeedRecord[]) => {
    const seen = new Set<string>();
    for (const { id } of records) {
      if (seen.has(id)) problems.push(`${what} ${id} is listed twice`);
      seen.add(id);
    }
    return seen;
  };
  const schools = ids("school", seed.schools);
  const terms = ids("term", seed.terms);
  const courses = ids("course", seed.courses);
  const sections = ids("section", seed.sections);
  ids("assignment", seed.assignments ?? []);
  ids("person", seed.people);
  const people = new Map(seed.people.map((p) => [p.id, p]));
  const need = (set: Set<string>, what: string, id: string, from: string) => {
    if (!set.has(id)) problems.push(`${from} names unknown ${what} ${id}`);
  };
  const role = (id: string, roles: readonly PersonRole[], from: string) => {
    const person = people.get(id);
    if (person === undefined) problems.push(`${from} names unknown person ${id}`);
    else if (!roles.includes(person.role)) problems.push(`${from} names ${id}, who is a ${person.role}`);
  };
  for (const term of seed.terms) if (term.parentId !== undefined) need(terms, "term", term.parentId, `term ${term.id}`);
  for (const course of seed.courses) need(schools, "school", course.schoolId, `course ${course.id}`);
  for (const section of seed.sections) {
    const from = `section ${section.id}`;
    need(courses, "course", section.courseId, from);
    need(schools, "school", section.schoolId, from);
    if (section.termIds.length === 0) problems.push(`${from} has no term`);
    for (const id of section.termIds) need(terms, "term", id, from);
    for (const id of section.teacherIds) role(id, ["teacher", "staff", "administrator"], from);
    for (const id of section.studentIds) role(id, ["student"], from);
  }
  const vendorIds = { clever: new Set<string>(), google: new Set<string>() };
  for (const person of seed.people) {
    const from = `person ${person.id}`;
    const { clever, google } = person.vendorIds ?? {};
    if (clever !== undefined && !/^[0-9a-f]{24}$/.test(clever)) problems.push(`${from} has Clever ID ${clever}, not 24 hex digits`);
    if (google !== undefined && !/^[1-9][0-9]{0,20}$/.test(google)) problems.push(`${from} has Google ID ${google}, not a decimal ID`);
    for (const [vendor, id] of [["clever", clever], ["google", google]] as const) {
      if (id === undefined) continue;
      if (vendorIds[vendor].has(id)) problems.push(`${from} shares ${vendor} ID ${id} with another person`);
      vendorIds[vendor].add(id);
    }
    if (!exampleEmail(person.email)) problems.push(`${from} has email ${person.email}, not on a .example domain`);
    for (const id of person.schoolIds) need(schools, "school", id, from);
    if (person.role !== "guardian" && person.schoolIds.length === 0) problems.push(`${from} belongs to no school`);
    for (const id of person.guardianOf ?? []) role(id, ["student"], from);
  }
  for (const assignment of seed.assignments ?? []) {
    const from = `assignment ${assignment.id}`;
    need(sections, "section", assignment.sectionId, from);
    for (const submission of assignment.submissions ?? []) role(submission.studentId, ["student"], from);
  }
  if (problems.length > 0) throw new SeedError(`Invalid district seed ${seed.id}: ${problems.join("; ")}`);
  return seed;
}

/** A record's `modified` time, falling back to the seed's. */
export function modifiedOf(seed: DistrictSeed, record: SeedRecord): string {
  return record.modified ?? seed.modified;
}

/** A person's username: their own, or their email's local part. */
export function usernameOf(person: PersonSeed): string {
  return person.username ?? person.email.slice(0, person.email.lastIndexOf("@"));
}

/** One enrollment: a person's place in a section's roster. */
export interface SeedEnrollment {
  /** `<sectionId>:<personId>`. */
  readonly id: string;
  readonly section: SectionSeed;
  readonly personId: string;
  readonly role: "teacher" | "student";
  /** The section's first teacher. */
  readonly primary: boolean;
}

/** Every enrollment the seed's section rosters imply, teachers first. */
export function enrollmentsOf(seed: DistrictSeed): SeedEnrollment[] {
  return seed.sections.flatMap((section) => [
    ...section.teacherIds.map((personId, i) => ({ id: `${section.id}:${personId}`, section, personId, role: "teacher" as const, primary: i === 0 })),
    ...section.studentIds.map((personId) => ({ id: `${section.id}:${personId}`, section, personId, role: "student" as const, primary: false })),
  ]);
}

/**
 * The students a `large-removal` fault of `fraction` removes: the first `ceil(fraction × n)` of the
 * active students in ID order, so the same fault always removes the same people.
 */
export function studentsToRemove(seed: DistrictSeed, fraction: number): Set<string> {
  if (!(fraction >= 0 && fraction <= 1)) throw new RangeError("a large-removal fraction is between 0 and 1");
  const students = seed.people
    .filter((p) => p.role === "student" && (p.status ?? "active") === "active")
    .map((p) => p.id)
    .toSorted();
  return new Set(students.slice(0, Math.ceil(students.length * fraction)));
}

/**
 * The seed with `removed` people gone, along with their places in rosters and their submissions.
 * Guardians stay; their `guardianOf` loses the removed students.
 */
export function withoutPeople(seed: DistrictSeed, removed: ReadonlySet<string>): DistrictSeed {
  const keep = (id: string) => !removed.has(id);
  return {
    ...seed,
    people: seed.people.filter((p) => keep(p.id)).map((p) => (p.guardianOf === undefined ? p : { ...p, guardianOf: p.guardianOf.filter(keep) })),
    sections: seed.sections.map((s) => ({ ...s, teacherIds: s.teacherIds.filter(keep), studentIds: s.studentIds.filter(keep) })),
    ...(seed.assignments === undefined
      ? {}
      : { assignments: seed.assignments.map((a) => ({ ...a, submissions: (a.submissions ?? []).filter((s) => keep(s.studentId)) })) }),
  };
}
