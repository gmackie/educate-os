// A demo district as the vendor-neutral `DistrictSeed` the provider fakes (SCHO-201) serve, so one
// seed backs a district's Clever, OneRoster, Google Classroom, OIDC and LTI fakes at once. Seed IDs
// are fixture IDs (a OneRoster sourcedId, an LTI context's section, ClassLink's `SourcedId`), each
// person's `username` is their IdP subject (OneRoster `username`, ClassLink `LoginId`), and where the
// fixtures already hold a Clever or Google user ID it is carried as `vendorIds`, so the subject a
// fake asserts is the one the directory resolves.
//
// It is the package's `./fake-seed` export, not part of its root: the root stays free of the fakes'
// types, which need the DOM's fetch types that some consumers (the workspace scripts) do not load.
import type { DistrictSeed, PersonSeed, SectionSeed } from "@educateos/provider-fakes";
import type { DemoDistrict } from "../profile.ts";
import { classroomSeed } from "./classroom.ts";
import { SEEDED_AT, gradesOf, idBody, indexDirectory, splitName, subjectOf } from "./shared.ts";

/** OneRoster's grade codes, which the seed's `grade` and `grades` use: `KG`, then two digits. */
const gradeCode = (grade: string) => (grade === "K" ? "KG" : grade.padStart(2, "0"));

/**
 * A demo district as a provider-fake seed, with the same people, classes and rosters as its
 * directory:
 * - Sections are offerings. Teachers are the active lead teachers then co-teachers; students are
 *   the active students, so a dropped student is not on the roster.
 * - A course belongs to the school of its first offering (the fakes' courses are per school).
 * - Staff who teach are `teacher`s, other district or school administrators `administrator`s, and
 *   the rest `staff`. Staff with no school of their own (a district administrator) belong to every
 *   school.
 * - In a district with Google accounts every person's email is their account's, `<fixture ID
 *   body>@<slug>.example` as in {@link classroomSeed}, since Classroom finds people by it. Elsewhere it
 *   is their directory email, or that address when they have none.
 * - In a Clever district `vendorIds.clever` is the person's IdP subject, which is their Clever user
 *   ID (as in `cleverSeed`). In a district with Google accounts `vendorIds.google` is their Google
 *   user ID from {@link classroomSeed}; guardians have none.
 */
export function fakeSeed(demo: DemoDistrict): DistrictSeed {
  const { directory, guardians, profile } = demo;
  const lookup = indexDirectory(directory);
  const domain = `${demo.slug}.example`;
  const usesClever = profile.sso === "clever" || profile.roster === "clever";
  const usesGoogle = profile.sso === "google" || profile.roster === "google-classroom" || profile.lms === "google-classroom";
  const google = usesGoogle ? new Map(classroomSeed(demo).users.map((u) => [u.fixtureId, u.id])) : undefined;
  const allSchools = directory.schools.map((s) => s.id);

  const teaching = (offeringId: string, role: "teacher" | "co-teacher") =>
    directory.enrollments.filter((e) => e.offeringId === offeringId && e.role === role && e.status === "active").map((e) => e.principalId);
  const sections = directory.offerings.map((o): SectionSeed => {
    const course = lookup.course.get(o.courseId)!;
    return {
      id: o.id,
      title: `${course.title} - ${o.sectionName}`,
      courseId: o.courseId,
      schoolId: o.schoolId,
      termIds: [o.termId],
      period: o.sectionName,
      grades: gradesOf(course.gradeBand).map(gradeCode),
      teacherIds: [...teaching(o.id, "teacher"), ...teaching(o.id, "co-teacher")],
      studentIds: directory.enrollments.filter((e) => e.offeringId === o.id && e.role === "student" && e.status === "active").map((e) => e.principalId),
    };
  });

  const people = directory.principals.map((p): PersonSeed => {
    const { first, last } = splitName(p.displayName);
    const roles = directory.roleAssignments.filter((r) => r.principalId === p.id);
    const teaches = directory.enrollments.some((e) => e.principalId === p.id && e.role !== "student" && e.status === "active");
    const role: PersonSeed["role"] = p.kind === "student" ? "student"
      : p.kind === "guardian" ? "guardian"
      : teaches ? "teacher"
      : roles.some((r) => r.role === "district-admin" || r.role === "school-admin") ? "administrator"
      : "staff";
    const schools = lookup.schoolsOf(p.id);
    const grade = p.kind === "student" ? lookup.gradeOf(p.id) : undefined;
    const vendorIds = { ...(usesClever ? { clever: subjectOf(p) } : {}), ...(google?.has(p.id) ? { google: google.get(p.id)! } : {}) };
    return {
      id: p.id,
      role,
      givenName: first,
      familyName: last,
      email: usesGoogle || p.email === undefined ? `${idBody(p.id)}@${domain}` : p.email,
      username: subjectOf(p),
      schoolIds: role === "guardian" ? [] : schools.length > 0 ? schools : allSchools,
      ...(grade === undefined ? {} : { grade: gradeCode(grade) }),
      ...(p.status === "active" ? {} : { status: "tobedeleted" as const }),
      ...(role === "guardian" ? { guardianOf: guardians.filter((g) => g.guardianPrincipalId === p.id).map((g) => g.studentPrincipalId), relationship: "parent" as const } : {}),
      ...(Object.keys(vendorIds).length === 0 ? {} : { vendorIds }),
    };
  });

  return {
    id: demo.slug,
    name: directory.district.name,
    domain,
    modified: SEEDED_AT,
    schools: directory.schools.map((s) => {
      const grades = s.gradeBands.flatMap(gradesOf).map(gradeCode);
      return { id: s.id, name: s.name, lowGrade: grades[0]!, highGrade: grades.at(-1)! };
    }),
    terms: directory.terms.map((t) => ({ id: t.id, name: t.name, type: "semester" as const, startDate: t.startsOn, endDate: t.endsOn, schoolYear: t.endsOn.slice(0, 4) })),
    courses: directory.courses.map((c) => ({
      id: c.id,
      title: c.title,
      schoolId: directory.offerings.find((o) => o.courseId === c.id)?.schoolId ?? allSchools[0]!,
      courseCode: c.id,
      subject: c.subject,
      grades: gradesOf(c.gradeBand).map(gradeCode),
    })),
    sections,
    people,
  };
}
