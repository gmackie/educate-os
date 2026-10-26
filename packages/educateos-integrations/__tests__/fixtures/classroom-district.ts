// A demo district as the Google Classroom fake serves it, and domain-wide delegation over that
// fake. The seed follows `classroomSeed` in @educateos/fixtures, which the live demo tenant is
// seeded from too: one Workspace account per staff member and student, and one course per active
// offering with a lead teacher, aliased `d:<offering ID>`. As in the live tenant, the accounts are
// on a Workspace domain of their own (`<slug>.gedu.example`), not the directory's email domain.
import { classroomSeed, type DemoDistrict } from "@educateos/fixtures";
import { GoogleClassroomFake, type AssignmentSeed, type DistrictSeed, type PersonSeed } from "@educateos/provider-fakes";
import { RosterSyncError } from "../../src/index.ts";
import type { googleclassroom } from "../../src/index.ts";

const SEEDED_AT = "2026-08-17T15:00:00.000Z";

/** The Workspace domain of a demo district's Classroom accounts. */
export function workspaceDomain(demo: DemoDistrict): string {
  return `${demo.slug}.gedu.example`;
}

/** A demo district as a `DistrictSeed`, with its district administrators as Workspace administrators. */
export function classroomDistrictSeed(demo: DemoDistrict, assignments: readonly AssignmentSeed[] = []): DistrictSeed {
  const { directory } = demo;
  const seed = classroomSeed(demo, workspaceDomain(demo));
  const offeringOf = new Map(directory.offerings.map((o) => [o.id as string, o]));
  const admins = new Set(directory.roleAssignments.filter((r) => r.role === "district-admin").map((r) => r.principalId as string));
  const teaches = new Set(directory.enrollments.filter((e) => e.role !== "student").map((e) => e.principalId as string));
  const schoolsOf = (principalId: string) => {
    const ids = directory.enrollments.filter((e) => e.principalId === principalId).map((e) => offeringOf.get(e.offeringId)!.schoolId as string);
    return ids.length === 0 ? [directory.schools[0]!.id as string] : [...new Set(ids)];
  };
  const byGoogleId = new Map(seed.users.map((u) => [u.id, u]));
  const people: PersonSeed[] = seed.users.map((u) => ({
    id: u.fixtureId,
    role: admins.has(u.fixtureId) ? "administrator" : u.kind === "student" ? "student" : teaches.has(u.fixtureId) ? "teacher" : "staff",
    givenName: u.name.givenName,
    familyName: u.name.familyName,
    email: u.primaryEmail,
    schoolIds: schoolsOf(u.fixtureId),
  }));
  return {
    id: demo.slug,
    name: directory.district.name,
    domain: seed.domain,
    modified: SEEDED_AT,
    schools: directory.schools.map((s) => ({ id: s.id, name: s.name })),
    terms: directory.terms.map((t) => ({ id: t.id, name: t.name, type: "term" as const, startDate: t.startsOn, endDate: t.endsOn, schoolYear: t.endsOn.slice(0, 4) })),
    courses: directory.courses.map((c) => ({
      id: c.id,
      title: c.title,
      schoolId: directory.offerings.find((o) => o.courseId === c.id)?.schoolId ?? directory.schools[0]!.id,
    })),
    sections: seed.courses.map((course) => {
      const offering = offeringOf.get(course.fixtureId)!;
      const fixtureIdOf = (userId: string) => byGoogleId.get(userId)!.fixtureId;
      const teachers = seed.teachers.filter((m) => m.courseId === course.id).map((m) => fixtureIdOf(m.userId));
      const owner = fixtureIdOf(course.ownerId);
      return {
        id: course.fixtureId,
        title: course.name,
        section: course.section,
        courseId: offering.courseId,
        schoolId: offering.schoolId,
        termIds: [offering.termId],
        teacherIds: [owner, ...teachers.filter((t) => t !== owner)],
        studentIds: seed.students.filter((m) => m.courseId === course.id).map((m) => fixtureIdOf(m.userId)),
        aliases: [course.alias],
      };
    }),
    people,
    assignments,
  };
}

/**
 * Domain-wide delegation over the fake: a token acting as a Workspace user is the fake's token for
 * the seed person with that email, granted `scopes`. `issued` counts tokens per subject.
 */
export function fakeDelegation(fake: GoogleClassroomFake, seed: DistrictSeed, scopes: readonly string[]): googleclassroom.DelegatedTokens & { issued: Map<string, number> } {
  const issued = new Map<string, number>();
  const cache = new Map<string, string>();
  return {
    issued,
    async token(subject) {
      const cached = cache.get(subject);
      if (cached !== undefined) return cached;
      const person = seed.people.find((p) => p.email === subject);
      if (person === undefined) throw new RosterSyncError("auth-failed", "no such Workspace user");
      const token = fake.issueToken({ userId: person.id, scopes: [...scopes] });
      issued.set(subject, (issued.get(subject) ?? 0) + 1);
      cache.set(subject, token);
      return token;
    },
    invalidate(subject, token) {
      if (cache.get(subject) === token) cache.delete(subject);
    },
  };
}

/** A seed person's Workspace email. */
export function emailOf(seed: DistrictSeed, personId: string): string {
  return seed.people.find((p) => p.id === personId)!.email;
}
