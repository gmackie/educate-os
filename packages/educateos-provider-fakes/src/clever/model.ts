// Projects a vendor-neutral seed into Clever Data API v3.x records, following the field tables of
// https://dev.clever.com/docs/districts, /schools, /terms, /sections and /users. Fields Clever marks
// "not guaranteed" are left out when the seed has nothing for them, as Clever leaves them out.
import { modifiedOf, usernameOf } from "../seed.ts";
import type { DistrictSeed, PersonSeed, SectionSeed, SeedRecord } from "../types.ts";
import { cleverDistrictId, cleverId, cleverLegacyId, cleverUserId, type CleverCollection, type CleverRole } from "./ids.ts";

/** A Clever record as the API serves it: a JSON object with an `id`. */
export type CleverRecord = { readonly id: string } & Record<string, unknown>;

/** Every record a seed projects into, by collection, each keyed by Clever ID. */
export type CleverRecords = Record<CleverCollection, Map<string, CleverRecord>>;

/** Extra roles for people who hold more than one in Clever (teachers, staff, admins only). */
export type CleverExtraRoles = Readonly<Record<string, readonly ("teacher" | "staff" | "district_admin")[]>>;

/** The Clever role a seed person's own role maps to. */
export function cleverRoleOf(person: PersonSeed): CleverRole {
  switch (person.role) {
    case "student":
      return "student";
    case "teacher":
      return "teacher";
    case "staff":
      return "staff";
    case "administrator":
      return "district_admin";
    case "guardian":
      return "contact";
  }
}

/** A OneRoster grade (`"09"`, `"KG"`) in Clever's normalized grade values (`"9"`, `"Kindergarten"`). */
export function cleverGrade(grade: string | undefined): string | undefined {
  if (grade === undefined) return undefined;
  const named: Record<string, string> = {
    PK: "PreKindergarten",
    TK: "TransitionalKindergarten",
    KG: "Kindergarten",
    IT: "InfantToddler",
    PR: "Preschool",
    PS: "PostGraduate",
    UG: "Ungraded",
    Other: "Other",
  };
  if (named[grade] !== undefined) return named[grade];
  const n = Number(grade);
  return Number.isInteger(n) && n >= 1 && n <= 13 ? String(n) : "Other";
}

/** A free-text subject in Clever's normalized section subjects. */
export function cleverSubject(subject: string | undefined): string {
  const s = (subject ?? "").toLowerCase();
  if (s === "") return "";
  if (/english|language arts|reading|literature/.test(s)) return "english/language arts";
  if (/math|algebra|geometry|calculus/.test(s)) return "math";
  if (/science|biology|chemistry|physics/.test(s)) return "science";
  if (/history|social|civics|government|geography/.test(s)) return "social studies";
  if (/spanish|french|german|chinese|latin|world language/.test(s)) return "language";
  if (/homeroom|advisory/.test(s)) return "homeroom/advisory";
  if (/computer|technology|engineering/.test(s)) return "technology and engineering";
  if (/physical|health|\bpe\b/.test(s)) return "PE and health";
  if (/art|music|band|choir|drama/.test(s)) return "arts and music";
  return "other";
}

const RELATIONSHIP: Record<string, string> = {
  parent: "Parent",
  guardian: "Parent",
  relative: "Relative",
  "aunt/uncle": "Aunt/Uncle",
  grandparent: "Grandparent",
  sibling: "Sibling",
  other: "Other",
};

function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

function roleBody(seed: DistrictSeed, person: PersonSeed, role: CleverRole): Record<string, unknown> {
  const schools = person.schoolIds.map((id) => cleverId(seed, "schools", id));
  const credentials = { district_username: usernameOf(person) };
  const legacy_id = cleverLegacyId(seed, person.id, role);
  switch (role) {
    case "student":
      return defined({
        credentials,
        enrollments: [],
        ext: {},
        grade: cleverGrade(person.grade),
        legacy_id,
        school: schools[0],
        schools,
        sis_id: person.id,
        student_number: person.localId,
      });
    case "teacher":
      return defined({ credentials, ext: {}, legacy_id, school: schools[0], schools, sis_id: person.id, teacher_number: person.localId });
    case "staff":
      return defined({ credentials, ext: {}, legacy_id, roles: [], schools, staff_id: person.localId ?? person.id });
    case "district_admin":
      return { legacy_id };
    case "contact":
      return {
        legacy_id,
        sis_id: person.id,
        student_relationships: (person.guardianOf ?? []).map((studentId) => ({
          relationship: RELATIONSHIP[person.relationship ?? "guardian"],
          student: cleverUserId(seed, studentId),
          type: "Parent/Guardian",
        })),
      };
  }
}

function sectionName(seed: DistrictSeed, section: SectionSeed): string {
  // Clever builds a section's name from course name, primary teacher's last name and period.
  const course = seed.courses.find((c) => c.id === section.courseId);
  const teacher = seed.people.find((p) => p.id === section.teacherIds[0]);
  if (course === undefined) return section.title;
  return [course.title, teacher?.familyName, section.period === undefined ? undefined : `Period ${section.period}`]
    .filter((part) => part !== undefined)
    .join(" - ");
}

/**
 * Projects `seed` into Clever records. Seed records with status `tobedeleted` are not shared with
 * the app, so they do not appear. `created` and `last_modified` come from the seed's `modified`.
 */
export function projectClever(seed: DistrictSeed, extraRoles: CleverExtraRoles = {}): CleverRecords {
  const district = cleverDistrictId(seed);
  const active = <T extends { status?: string }>(records: readonly T[]) => records.filter((r) => (r.status ?? "active") === "active");
  const people = active(seed.people);
  const present = new Set(people.map((p) => p.id));
  const stamps = (record: SeedRecord) => {
    const at = modifiedOf(seed, record);
    return { created: seed.modified <= at ? seed.modified : at, last_modified: at };
  };
  const out: CleverRecords = { districts: new Map(), schools: new Map(), terms: new Map(), courses: new Map(), sections: new Map(), users: new Map() };
  const put = (collection: CleverCollection, record: CleverRecord) => out[collection].set(record.id, record);

  put("districts", {
    id: district,
    name: seed.name,
    sis_type: "sftp",
    launch_date: seed.modified.slice(0, 10),
    portal_url: `https://clever.com/in/${seed.id}`,
    login_methods: ["Clever Badges", "Google"],
    state: "success",
    last_sync: seed.modified,
  });
  for (const school of active(seed.schools)) {
    put("schools", {
      id: cleverId(seed, "schools", school.id),
      district,
      name: school.name,
      sis_id: school.id,
      school_number: school.schoolNumber ?? school.id,
      ...defined({ low_grade: cleverGrade(school.lowGrade), high_grade: cleverGrade(school.highGrade) }),
      ext: {},
      ...stamps(school),
    });
  }
  for (const term of active(seed.terms)) {
    put("terms", { id: cleverId(seed, "terms", term.id), district, name: term.name, start_date: term.startDate, end_date: term.endDate });
  }
  for (const course of active(seed.courses)) {
    put("courses", defined({ id: cleverId(seed, "courses", course.id), district, name: course.title, number: course.courseCode }) as CleverRecord);
  }
  for (const section of active(seed.sections)) {
    const teachers = section.teacherIds.filter((id) => present.has(id)).map((id) => cleverUserId(seed, id));
    put("sections", {
      id: cleverId(seed, "sections", section.id),
      district,
      school: cleverId(seed, "schools", section.schoolId),
      course: cleverId(seed, "courses", section.courseId),
      term_id: cleverId(seed, "terms", section.termIds[0]!),
      name: sectionName(seed, section),
      sis_id: section.id,
      subject: cleverSubject(section.subject ?? seed.courses.find((c) => c.id === section.courseId)?.subject),
      ...defined({ grade: cleverGrade(section.grades?.[0]), period: section.period }),
      students: section.studentIds.filter((id) => present.has(id)).map((id) => cleverUserId(seed, id)),
      ...(teachers[0] === undefined ? {} : { teacher: teachers[0] }),
      teachers,
      ext: {},
      ...stamps(section),
    });
  }
  for (const person of people) {
    const primary = cleverRoleOf(person);
    // Students and contacts cannot hold more than one role (multi-role-users-in-clever).
    const extra = primary === "student" || primary === "contact" ? [] : (extraRoles[person.id] ?? []);
    const roles = Object.fromEntries([primary, ...extra].map((role) => [role, roleBody(seed, person, role)]));
    put("users", {
      id: cleverUserId(seed, person.id),
      district,
      email: person.email,
      name: defined({ first: person.givenName, last: person.familyName, middle: person.middleName ?? "" }),
      roles,
      ...stamps(person),
    });
  }
  return out;
}
