// A demo district as the vendor-neutral `DistrictSeed` every provider fake serves (SCHO-201), so a
// Clever, OneRoster, Classroom or LTI fake can stand in for a demo district's real provider. The
// vendor-shaped seeds beside this file are the records a fake would serve; this is what the fakes
// themselves take, and they derive their own vendor IDs from its IDs (see the provider-fakes README).
//
// The seed's types are declared here rather than imported: importing @educateos/provider-fakes
// would make every package that compiles the fixtures compile the fakes too, under its own
// typings. They are the subset of provider-fakes' `DistrictSeed` this adapter fills, and the
// integrations tests, which pass the result straight to the fakes, fail to compile if they drift.
import type { DemoDistrict } from "../profile.ts";
import { SEEDED_AT, gradesOf, idBody, indexDirectory, splitName } from "./shared.ts";

/** A person, as provider-fakes' `PersonSeed`. */
export interface FakePersonSeed {
  readonly id: string;
  readonly status?: "active" | "tobedeleted";
  readonly role: "student" | "teacher" | "staff" | "administrator" | "guardian";
  readonly givenName: string;
  readonly familyName: string;
  readonly email: string;
  readonly username?: string;
  readonly schoolIds: readonly string[];
  readonly grade?: string;
  readonly guardianOf?: readonly string[];
  readonly relationship?: "parent";
}

/** A district, as provider-fakes' `DistrictSeed`, without assignments. */
export interface FakeDistrictSeed {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly modified: string;
  readonly schools: readonly { readonly id: string; readonly name: string; readonly lowGrade?: string; readonly highGrade?: string }[];
  readonly terms: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: "term";
    readonly startDate: string;
    readonly endDate: string;
    readonly schoolYear: string;
  }[];
  readonly courses: readonly {
    readonly id: string;
    readonly title: string;
    readonly schoolId: string;
    readonly courseCode?: string;
    readonly subject?: string;
    readonly grades?: readonly string[];
  }[];
  readonly sections: readonly {
    readonly id: string;
    readonly title: string;
    readonly courseId: string;
    readonly schoolId: string;
    readonly termIds: readonly string[];
    readonly grades?: readonly string[];
    readonly teacherIds: readonly string[];
    readonly studentIds: readonly string[];
  }[];
  readonly people: readonly FakePersonSeed[];
}

/** Options of {@link districtSeed}. */
export interface DistrictSeedOptions {
  /**
   * Whether sections list the students whose enrollments have since ended, as the roster stood
   * before any mid-term drop. A test can then sync, apply the drop at the fake, and watch the
   * enrollment end. False when absent: sections list only current enrollments.
   */
  includeEndedEnrollments?: boolean;
}

/** Subjects as the free text a fake projects into each vendor's subject vocabulary. */
const SUBJECT_TEXT = {
  "english-language-arts": "english language arts",
  science: "science",
  "history-social-studies": "social studies",
  mathematics: "mathematics",
  arts: "arts",
  "world-languages": "world languages",
  "computer-science": "computer science",
  "health-physical-education": "health",
  "social-emotional-learning": "social emotional learning",
  other: "other",
} as const;

/** A grade as OneRoster writes it: `KG`, `01` … `12`. */
function gradeCode(grade: string): string {
  return grade === "K" ? "KG" : grade.padStart(2, "0");
}

/**
 * A demo district as a provider-fake seed. Every seed ID is the fixture's own ID, so a fake's
 * records trace back to the fixture, and a person's vendor ID is the fake's hash of their principal
 * ID (`CleverDataFake.userId(principalId)`), not the subject in the fixture's directory.
 *
 * The district's domain is `<slug>.example`. A principal with no email gets one there, from their
 * fixture ID. Usernames are the fixture ID's body, since some fixtures share an email on purpose.
 */
export function districtSeed(demo: DemoDistrict, options: DistrictSeedOptions = {}): FakeDistrictSeed {
  const { directory, guardians } = demo;
  const lookup = indexDirectory(directory);
  const domain = `${demo.slug}.example`;
  const counted = (status: string) => status === "active" || (options.includeEndedEnrollments === true && status === "inactive");
  const admins = new Set(directory.roleAssignments.filter((r) => r.role === "district-admin").map((r) => r.principalId));

  const people = directory.principals.map((principal): FakePersonSeed => {
    const enrollments = directory.enrollments.filter((e) => e.principalId === principal.id);
    const role: FakePersonSeed["role"] = principal.kind === "student"
      ? "student"
      : principal.kind === "guardian"
      ? "guardian"
      : enrollments.some((e) => e.role !== "student")
      ? "teacher"
      : admins.has(principal.id)
      ? "administrator"
      : "staff";
    const { first, last } = splitName(principal.displayName);
    const grade = principal.kind === "student" ? lookup.gradeOf(principal.id) : undefined;
    const schools = lookup.schoolsOf(principal.id);
    const students = guardians.filter((g) => g.guardianPrincipalId === principal.id).map((g) => g.studentPrincipalId as string);
    return {
      id: principal.id,
      role,
      givenName: first,
      familyName: last,
      email: principal.email ?? `${idBody(principal.id)}@${domain}`,
      username: idBody(principal.id),
      // A fake needs every non-guardian at a school; someone the directory places at none (a
      // district administrator) works at all of them.
      schoolIds: schools.length > 0 || role === "guardian" ? schools : directory.schools.map((s) => s.id as string),
      ...(principal.status === "active" ? {} : { status: "tobedeleted" as const }),
      ...(grade === undefined ? {} : { grade: gradeCode(grade) }),
      ...(role === "guardian" ? { guardianOf: students, relationship: "parent" as const } : {}),
    };
  });

  return {
    id: demo.slug,
    name: directory.district.name,
    domain,
    modified: SEEDED_AT,
    schools: directory.schools.map((school) => {
      const grades = school.gradeBands.flatMap(gradesOf).map(gradeCode);
      return { id: school.id, name: school.name, lowGrade: grades[0]!, highGrade: grades.at(-1)! };
    }),
    terms: directory.terms.map((term) => ({
      id: term.id,
      name: term.name,
      type: "term" as const,
      startDate: term.startsOn,
      endDate: term.endsOn,
      schoolYear: term.endsOn.slice(0, 4),
    })),
    courses: directory.courses.map((course) => ({
      id: course.id,
      title: course.title,
      schoolId: directory.offerings.find((o) => o.courseId === course.id)?.schoolId ?? directory.schools[0]!.id,
      courseCode: idBody(course.id),
      subject: SUBJECT_TEXT[course.subject],
      grades: gradesOf(course.gradeBand).map(gradeCode),
    })),
    sections: directory.offerings.map((offering) => {
      const course = lookup.course.get(offering.courseId)!;
      const members = directory.enrollments.filter((e) => e.offeringId === offering.id && counted(e.status));
      return {
        id: offering.id,
        title: offering.sectionName,
        courseId: offering.courseId,
        schoolId: offering.schoolId,
        termIds: [offering.termId],
        grades: gradesOf(course.gradeBand).map(gradeCode),
        // The lead teacher first, then any co-teachers.
        teacherIds: [...members.filter((e) => e.role === "teacher"), ...members.filter((e) => e.role === "co-teacher")].map((e) => e.principalId as string),
        studentIds: members.filter((e) => e.role === "student").map((e) => e.principalId as string),
      };
    }),
    people,
  };
}
