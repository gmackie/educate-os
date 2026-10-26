// Maps Clever Data API v3.1 records into the OneRoster row model the roster pipeline imports, so a
// Clever roster shares every rule of the OneRoster path: quarantine, all-or-nothing apply,
// deactivate rather than delete, and the large-removal hold. New for EducateOS.
//
// Clever has no enrollment records: a section lists its teachers and students. Each (section, user)
// pair becomes an enrollment row, with a sourcedId derived from the pair.
import type { OneRosterRecord, OneRosterRole } from "../oneroster/spec.ts";
import type { CleverRecord } from "./schemas.ts";

/** The `userIds` type under which each user's Clever ID is recorded. */
export const CLEVER_USER_ID_TYPE = "clever";

/**
 * Where a Clever roster's subjects are: the Clever user ID, which is the `sub` Clever SSO asserts.
 * A district's `rostering.identityMapping.subject` for Clever.
 */
export const CLEVER_SUBJECT_FIELD = { field: "userIds", type: CLEVER_USER_ID_TYPE } as const;

/** Whether a record is current or, in a delta, deleted. */
export type CleverStatus = "active" | "tobedeleted";

/** Rows in the shape the row schemas validate. */
export type CleverRows = { [F in keyof RowShapes]: RowShapes[F][] };
interface RowShapes {
  "orgs.csv": Partial<OneRosterRecord<"orgs.csv">>;
  "academicSessions.csv": Partial<OneRosterRecord<"academicSessions.csv">>;
  "courses.csv": Partial<OneRosterRecord<"courses.csv">>;
  "classes.csv": Partial<OneRosterRecord<"classes.csv">>;
  "users.csv": Partial<OneRosterRecord<"users.csv">>;
  "roles.csv": Partial<OneRosterRecord<"roles.csv">>;
  "enrollments.csv": Partial<OneRosterRecord<"enrollments.csv">>;
}

/**
 * Clever's normalized section subjects (https://dev.clever.com/docs/sections), as names the
 * OneRoster subject table recognises. Any other subject passes through lowercased, and the
 * OneRoster table maps what it does not know to `other`.
 */
const SUBJECTS: Readonly<Record<string, string>> = {
  "english/language arts": "english language arts",
  "math": "math",
  "science": "science",
  "social studies": "social studies",
  "language": "world languages",
  "technology and engineering": "computer science",
  "pe and health": "health",
  "arts and music": "arts",
};

/** A Clever section subject, as a name the OneRoster subject table reads. */
export function cleverSubjectName(subject: string | undefined): string | undefined {
  if (subject === undefined || subject.trim() === "") return undefined;
  const key = subject.trim().toLowerCase();
  return Object.hasOwn(SUBJECTS, key) ? SUBJECTS[key] : key;
}

/**
 * A Clever grade (`"Kindergarten"`, `"1"` … `"13"`, `"PreKindergarten"` …) as a OneRoster grade
 * code. Codes EducateOS grade bands cannot hold pass through unchanged and are ignored downstream.
 */
export function cleverGradeCode(grade: string | undefined): string | undefined {
  if (grade === undefined || grade.trim() === "") return undefined;
  const value = grade.trim();
  if (value.toLowerCase() === "kindergarten") return "KG";
  return /^\d{1,2}$/.test(value) ? value.padStart(2, "0") : value;
}

/** A OneRoster grade code as a number, kindergarten as 0, or undefined for anything else. */
function gradeNumber(code: string | undefined): number | undefined {
  return code === "KG" ? 0 : code !== undefined && /^\d{2}$/.test(code) ? Number(code) : undefined;
}

/** The OneRoster grade codes from `low` to `high` inclusive, when both are K-12 grades. */
function gradeRange(low: string | undefined, high: string | undefined): string[] {
  const from = gradeNumber(cleverGradeCode(low));
  const to = gradeNumber(cleverGradeCode(high));
  if (from === undefined || to === undefined || from > to || to > 12) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => (from + i === 0 ? "KG" : String(from + i).padStart(2, "0")));
}

/** A date as `YYYY-MM-DD`, from Clever's date or a timestamp; anything else is passed on to fail validation. */
function calendarDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim());
  return match?.[1] ?? value;
}

/** The sourcedId of the enrollment of `user` in `section`. */
export function enrollmentSourcedId(section: string, user: string): string {
  return `${section}:${user}`;
}

/** The sourcedId of the course a section with no Clever course is given, so it can still be offered. */
export function sectionCourseSourcedId(section: string): string {
  return `section:${section}`;
}

/** How each Clever contact relationship reads as a OneRoster role. */
function contactRole(relationship: string | undefined): OneRosterRole {
  const value = (relationship ?? "").toLowerCase();
  if (value === "parent") return "parent";
  if (["relative", "aunt/uncle", "grandparent", "sibling"].includes(value)) return "relative";
  return "guardian";
}

/** Maps Clever records into rows. Every function returns rows unvalidated; the source validates them. */
export const cleverRows = {
  district(record: CleverRecord<"districts">, status: CleverStatus): RowShapes["orgs.csv"] {
    return { sourcedId: record.id, status, name: record.name, type: "district" };
  },

  school(record: CleverRecord<"schools">, status: CleverStatus): RowShapes["orgs.csv"] {
    return { sourcedId: record.id, status, name: record.name, type: "school", parentSourcedId: record.district };
  },

  term(record: CleverRecord<"terms">, status: CleverStatus): RowShapes["academicSessions.csv"] {
    return {
      sourcedId: record.id,
      status,
      title: record.name ?? "",
      type: "term",
      startDate: calendarDate(record.start_date) as string,
      endDate: calendarDate(record.end_date) as string,
    };
  },

  /**
   * A course. Clever courses carry no grades or subject, so they come from the course's sections:
   * `sections` lists the subject and grade of each, and `fallbackGrades` the grades of their
   * schools, for a course whose sections list none.
   */
  course(
    record: CleverRecord<"courses">,
    status: CleverStatus,
    sections: readonly { subject?: string; grade?: string }[],
    fallbackGrades: readonly string[],
  ): RowShapes["courses.csv"] {
    const grades = unique(sections.map((s) => cleverGradeCode(s.grade)));
    return {
      sourcedId: record.id,
      status,
      title: record.name ?? record.number ?? "",
      grades: grades.length > 0 ? grades : [...fallbackGrades],
      orgSourcedId: record.district,
      subjects: unique(sections.map((s) => cleverSubjectName(s.subject))),
      subjectCodes: [],
    };
  },

  /** The course of a section that names none, titled after the section. */
  sectionCourse(record: CleverRecord<"sections">, status: CleverStatus, fallbackGrades: readonly string[]): RowShapes["courses.csv"] {
    const grade = cleverGradeCode(record.grade);
    const subject = cleverSubjectName(record.subject);
    return {
      sourcedId: sectionCourseSourcedId(record.id),
      status,
      title: record.course_name ?? record.name ?? "",
      grades: grade === undefined ? [...fallbackGrades] : [grade],
      orgSourcedId: record.district,
      subjects: subject === undefined ? [] : [subject],
      subjectCodes: [],
    };
  },

  section(record: CleverRecord<"sections">, status: CleverStatus): RowShapes["classes.csv"] {
    const grade = cleverGradeCode(record.grade);
    return {
      sourcedId: record.id,
      status,
      // OneRoster caps a class title at 100 characters; Clever builds long section names.
      title: (record.name ?? record.course_name ?? "").slice(0, 100),
      grades: grade === undefined ? [] : [grade],
      courseSourcedId: record.course ?? sectionCourseSourcedId(record.id),
      classType: record.subject?.toLowerCase() === "homeroom/advisory" ? "homeroom" : "scheduled",
      schoolSourcedId: record.school,
      termSourcedIds: record.term_id === undefined ? [] : [record.term_id],
    };
  },

  /** A section's roster as enrollment rows: its teachers (the lead first), then its students. */
  enrollments(record: CleverRecord<"sections">, status: CleverStatus): RowShapes["enrollments.csv"][] {
    const lead = record.teacher ?? record.teachers[0];
    const rows = new Map<string, RowShapes["enrollments.csv"]>();
    const add = (user: string, role: "teacher" | "student") => {
      const sourcedId = enrollmentSourcedId(record.id, user);
      if (rows.has(sourcedId)) return;
      rows.set(sourcedId, {
        sourcedId,
        status,
        classSourcedId: record.id,
        schoolSourcedId: record.school,
        userSourcedId: user,
        role,
        ...(role === "teacher" ? { primary: user === lead } : {}),
      });
    };
    for (const teacher of record.teachers) add(teacher, "teacher");
    for (const student of record.students) add(student, "student");
    return [...rows.values()];
  },

  /**
   * A user and their roles. The Clever user ID is kept in `userIds`, where
   * {@link CLEVER_SUBJECT_FIELD} reads it. Clever's staff role has no standard vocabulary, so staff
   * become OneRoster `aide`s: staff principals that the roster grants nothing beyond their sections.
   * A district admin becomes a `districtAdministrator`, which the importer never turns into a grant.
   */
  user(record: CleverRecord<"users">, status: CleverStatus): { user: RowShapes["users.csv"]; roles: RowShapes["roles.csv"][] } {
    const { student, teacher, staff, district_admin: districtAdmin, contact } = record.roles;
    const bodies = [student, teacher, staff];
    const username = bodies.map((b) => b?.credentials?.district_username).find((u) => u !== undefined && u !== "");
    const sisId = [...bodies, contact].map((b) => b?.sis_id).find((s) => s !== undefined && s !== "");
    const grade = cleverGradeCode(student?.grade);
    const roles: RowShapes["roles.csv"][] = [];
    const add = (role: OneRosterRole, org: string) =>
      roles.push({ status, userSourcedId: record.id, roleType: roles.length === 0 ? "primary" : "secondary", role, orgSourcedId: org });
    const atSchools = (body: { school?: string; schools?: string[] } | undefined, role: OneRosterRole) => {
      if (body === undefined) return;
      const schools = unique([body.school, ...(body.schools ?? [])]);
      if (schools.length === 0) add(role, record.district);
      for (const school of schools) add(role, school);
    };
    atSchools(student, "student");
    atSchools(teacher, "teacher");
    atSchools(staff, "aide");
    if (districtAdmin !== undefined) add("districtAdministrator", record.district);
    if (contact !== undefined) {
      const kinds = unique((contact.student_relationships ?? []).map((r) => contactRole(r.relationship)));
      for (const role of kinds.length === 0 ? (["guardian"] as const) : kinds) add(role as OneRosterRole, record.district);
    }
    return {
      user: {
        sourcedId: record.id,
        status,
        enabledUser: true,
        ...(username === undefined ? {} : { username }),
        userIds: [{ type: CLEVER_USER_ID_TYPE, identifier: record.id }],
        givenName: record.name.first,
        familyName: record.name.last,
        ...(sisId === undefined ? {} : { identifier: sisId }),
        ...(record.email === undefined || record.email === "" ? {} : { email: record.email }),
        grades: grade === undefined ? [] : [grade],
      },
      roles,
    };
  },

  /** The grade codes a school serves, for courses whose sections list none. */
  schoolGrades(record: CleverRecord<"schools">): string[] {
    return gradeRange(record.low_grade, record.high_grade);
  },
};

function unique<T>(values: readonly (T | undefined)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== undefined))];
}
