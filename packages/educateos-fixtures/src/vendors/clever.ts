// A demo district as Clever API v3.1 data: plain JSON records in the shape of each endpoint's
// `data` objects, for a Clever fake (SCHO-201) to serve. Field names follow Clever's v3.1
// reference; only the fields EducateOS reads, plus `sis_id` links back to the fixtures, are set.
import type { Subject } from "@educateos/contracts";
import type { DemoDistrict } from "../profile.ts";
import { SEEDED_AT, gradesOf, indexDirectory, splitName, stableHex, subjectOf } from "./shared.ts";

/** Clever's section subject vocabulary, for the EducateOS subjects the fixtures use. */
const CLEVER_SUBJECT: Readonly<Record<Subject, string>> = {
  "english-language-arts": "english/language arts",
  science: "science",
  "history-social-studies": "social studies",
  mathematics: "math",
  arts: "arts and music",
  "world-languages": "language",
  "computer-science": "technology and engineering",
  "health-physical-education": "PE and health",
  "social-emotional-learning": "other",
  other: "other",
};

/** A Clever v3.1 district. */
export interface CleverDistrict {
  id: string;
  name: string;
}

/** A Clever v3.1 school. */
export interface CleverSchool {
  id: string;
  district: string;
  name: string;
  sis_id: string;
  school_number: string;
  low_grade: string;
  high_grade: string;
  created: string;
  last_modified: string;
}

/** A Clever v3.1 term. */
export interface CleverTerm {
  id: string;
  district: string;
  name: string;
  start_date: string;
  end_date: string;
}

/** A Clever v3.1 course. */
export interface CleverCourse {
  id: string;
  district: string;
  name: string;
  number: string;
}

/** A Clever v3.1 section. `students` lists only students currently in it. */
export interface CleverSection {
  id: string;
  district: string;
  school: string;
  course: string;
  term_id: string;
  sis_id: string;
  name: string;
  section_number: string;
  subject: string;
  grade: string;
  teacher: string;
  teachers: string[];
  students: string[];
  created: string;
  last_modified: string;
}

/** A Clever v3.1 user. Its ID is the subject Clever SSO asserts for it. */
export interface CleverUser {
  id: string;
  district: string;
  email?: string;
  name: { first: string; last: string };
  roles: {
    student?: { district: string; school: string; schools: string[]; sis_id: string; student_number: string; grade?: string };
    teacher?: { district: string; school: string; schools: string[]; sis_id: string };
    staff?: { district: string; schools: string[]; sis_id: string };
    district_admin?: { district: string };
    contact?: {
      district: string;
      sis_id: string;
      student_relationships: { student: string; relationship: "Parent"; type: "Parent/Guardian" }[];
    };
  };
  created: string;
  last_modified: string;
}

/** A Clever v3.1 event, as the events endpoint lists it. */
export interface CleverEvent {
  id: string;
  type: "sections.updated";
  created: string;
  data: { object: CleverSection; previous_attributes: { students: string[] } };
}

/** Everything a Clever fake serves for one district. */
export interface CleverSeed {
  district: CleverDistrict;
  schools: CleverSchool[];
  terms: CleverTerm[];
  courses: CleverCourse[];
  sections: CleverSection[];
  users: CleverUser[];
  /** One `sections.updated` event per student dropped from a section. */
  events: CleverEvent[];
}

/**
 * A demo district as Clever holds it. Each user's ID is their IdP subject in the directory (the
 * subject Clever SSO asserts), and each record's `sis_id` is its fixture ID. Other Clever IDs are
 * derived from fixture IDs, so the seed is stable.
 */
export function cleverSeed(demo: DemoDistrict): CleverSeed {
  const { directory, guardians } = demo;
  const lookup = indexDirectory(directory);
  const id = (fixtureId: string) => stableHex(`clever:${fixtureId}`, 24);
  const district = id(directory.district.id);
  const stamps = { created: SEEDED_AT, last_modified: SEEDED_AT };
  const userId = (principalId: string) => subjectOf(lookup.principal.get(principalId)!);

  const sections = directory.offerings.map((offering): CleverSection => {
    const course = lookup.course.get(offering.courseId)!;
    const members = directory.enrollments.filter((e) => e.offeringId === offering.id && e.status === "active");
    // The lead teacher first, then any co-teachers.
    const teachers = [...members.filter((e) => e.role === "teacher"), ...members.filter((e) => e.role === "co-teacher")];
    return {
      id: id(offering.id),
      district,
      school: id(offering.schoolId),
      course: id(course.id),
      term_id: id(offering.termId),
      sis_id: offering.id,
      name: `${course.title} - ${offering.sectionName}`,
      section_number: offering.sectionName,
      subject: CLEVER_SUBJECT[course.subject],
      grade: gradesOf(course.gradeBand)[0]!,
      teacher: userId(teachers[0]!.principalId),
      teachers: teachers.map((e) => userId(e.principalId)),
      students: members.filter((e) => e.role === "student").map((e) => userId(e.principalId)),
      ...stamps,
    };
  });

  const users = directory.principals.map((principal): CleverUser => {
    const schools = lookup.schoolsOf(principal.id).map(id);
    const roles: CleverUser["roles"] = {};
    const teachesAny = directory.enrollments.some((e) => e.principalId === principal.id && e.role !== "student");
    const admin = directory.roleAssignments.some((r) => r.principalId === principal.id && r.role === "district-admin");
    if (principal.kind === "student") {
      const grade = lookup.gradeOf(principal.id);
      roles.student = { district, school: schools[0]!, schools, sis_id: principal.id, student_number: principal.id, ...(grade === undefined ? {} : { grade }) };
    } else if (principal.kind === "guardian") {
      roles.contact = {
        district,
        sis_id: principal.id,
        student_relationships: guardians
          .filter((g) => g.guardianPrincipalId === principal.id)
          .map((g) => ({ student: userId(g.studentPrincipalId), relationship: "Parent", type: "Parent/Guardian" })),
      };
    } else {
      if (teachesAny) roles.teacher = { district, school: schools[0]!, schools, sis_id: principal.id };
      if (admin) roles.district_admin = { district };
      if (!teachesAny && !admin) roles.staff = { district, schools, sis_id: principal.id };
    }
    return {
      id: subjectOf(principal),
      district,
      ...(principal.email === undefined ? {} : { email: principal.email }),
      name: splitName(principal.displayName),
      roles,
      ...stamps,
    };
  });

  const events = directory.enrollments
    .filter((e) => e.role === "student" && e.status === "inactive")
    .map((e): CleverEvent => {
      const section = sections.find((s) => s.sis_id === e.offeringId)!;
      return {
        id: stableHex(`clever-event:${e.id}`, 24),
        type: "sections.updated",
        created: SEEDED_AT,
        data: { object: section, previous_attributes: { students: [...section.students, userId(e.principalId)] } },
      };
    });

  return {
    district: { id: district, name: directory.district.name },
    schools: directory.schools.map((school) => {
      const grades = school.gradeBands.flatMap(gradesOf);
      return {
        id: id(school.id),
        district,
        name: school.name,
        sis_id: school.id,
        school_number: school.id,
        low_grade: grades[0] === "K" ? "Kindergarten" : grades[0]!,
        high_grade: grades.at(-1)!,
        ...stamps,
      };
    }),
    terms: directory.terms.map((term) => ({ id: id(term.id), district, name: term.name, start_date: term.startsOn, end_date: term.endsOn })),
    courses: directory.courses.map((course) => ({ id: id(course.id), district, name: course.title, number: course.id })),
    sections,
    users,
    events,
  };
}
