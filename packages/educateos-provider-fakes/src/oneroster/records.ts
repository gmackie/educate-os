// Projects a `DistrictSeed` into OneRoster 1.2 rostering records, as the REST/JSON binding serves
// them. Followed: 1EdTech OneRoster 1.2 Rostering Service Information Model and REST/JSON Binding
// (https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html):
// the org, academicSession, course, class, user (1.2 `roles`, not 1.1 `role`/`orgs`) and
// enrollment classes, and the GUIDRef `{href, sourcedId, type}`. Optional fields are omitted
// rather than sent empty, as conforming servers do.
import { enrollmentsOf, modifiedOf, usernameOf } from "../seed.ts";
import type { DistrictSeed, PersonSeed, SeedStatus } from "../types.ts";

/** The rostering collections the fake stores. Endpoints such as `schools` and `terms` are views of these. */
export const ONEROSTER_COLLECTIONS = ["orgs", "academicSessions", "courses", "classes", "users", "enrollments"] as const;

/** One of {@link ONEROSTER_COLLECTIONS}. */
export type OneRosterCollection = (typeof ONEROSTER_COLLECTIONS)[number];

/** A OneRoster record as JSON. Every record has `sourcedId`, `status` and `dateLastModified`. */
export type OneRosterRecord = Record<string, unknown> & {
  sourcedId: string;
  status: SeedStatus;
  dateLastModified: string;
};

/** The path of the 1.2 rostering service below the server's base URL. */
export const ROSTERING_PATH = "/ims/oneroster/rostering/v1p2";

/** The GUIDRef `type` and the collection path of each record kind. */
const REF_PATH = { org: "orgs", academicSession: "academicSessions", course: "courses", class: "classes", user: "users", enrollment: "enrollments" } as const;

/** A GUIDRef `type`. */
export type RefType = keyof typeof REF_PATH;

/** Builds GUIDRefs whose `href` points at the record on this server. */
export function refBuilder(baseUrl: string): (type: RefType, sourcedId: string) => { href: string; sourcedId: string; type: RefType } {
  const root = `${baseUrl.replace(/\/+$/, "")}${ROSTERING_PATH}`;
  return (type, sourcedId) => ({ href: `${root}/${REF_PATH[type]}/${encodeURIComponent(sourcedId)}`, sourcedId, type });
}

/** How a seed role reads as OneRoster 1.2 roles: one per org the person belongs to. */
function rolesOf(seed: DistrictSeed, person: PersonSeed, ref: ReturnType<typeof refBuilder>) {
  if (person.role === "guardian") {
    // 1.2 distinguishes parents and guardians from other relatives; the org is the district.
    const relationship = person.relationship ?? "guardian";
    const role = relationship === "parent" ? "parent" : relationship === "guardian" ? "guardian" : "relative";
    return [{ roleType: "primary", role, org: ref("org", seed.id) }];
  }
  // 1.2 has no plain `staff` or `administrator` role: staff are aides, administrators run a site.
  const role = { student: "student", teacher: "teacher", staff: "aide", administrator: "siteAdministrator" }[person.role];
  return person.schoolIds.map((schoolId, i) => ({ roleType: i === 0 ? "primary" : "secondary", role, org: ref("org", schoolId) }));
}

const latest = (...times: string[]) => times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
const present = (record: Record<string, unknown>) => Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));

/** Every record the seed implies, by collection, in seed order. */
export function projectSeed(seed: DistrictSeed, baseUrl: string): Record<OneRosterCollection, OneRosterRecord[]> {
  const ref = refBuilder(baseUrl);
  const base = (record: { id: string; status?: SeedStatus; modified?: string }) => ({
    sourcedId: record.id,
    status: record.status ?? "active",
    dateLastModified: new Date(modifiedOf(seed, record)).toISOString(),
  });
  const people = new Map(seed.people.map((p) => [p.id, p]));
  const guardiansOf = (studentId: string) => seed.people.filter((p) => p.guardianOf?.includes(studentId)).map((p) => p.id);

  const orgs: OneRosterRecord[] = [
    present({ ...base({ id: seed.id }), name: seed.name, type: "district", children: seed.schools.map((s) => ref("org", s.id)) }) as OneRosterRecord,
    ...seed.schools.map((s) => present({ ...base(s), name: s.name, type: "school", identifier: s.schoolNumber, parent: ref("org", seed.id) }) as OneRosterRecord),
  ];
  const academicSessions = seed.terms.map((t) => present({
    ...base(t),
    title: t.name,
    startDate: t.startDate,
    endDate: t.endDate,
    type: t.type,
    parent: t.parentId === undefined ? undefined : ref("academicSession", t.parentId),
    children: seed.terms.filter((c) => c.parentId === t.id).map((c) => ref("academicSession", c.id)),
    schoolYear: t.schoolYear,
  }) as OneRosterRecord);
  const courses = seed.courses.map((c) => present({
    ...base(c),
    title: c.title,
    courseCode: c.courseCode,
    grades: c.grades,
    subjects: c.subject === undefined ? undefined : [c.subject],
    org: ref("org", c.schoolId),
  }) as OneRosterRecord);
  const classes = seed.sections.map((s) => {
    const course = seed.courses.find((c) => c.id === s.courseId);
    return present({
      ...base(s),
      title: s.title,
      classCode: course?.courseCode === undefined || s.period === undefined ? undefined : `${course.courseCode}-${s.period}`,
      classType: "scheduled",
      location: s.room,
      grades: s.grades ?? course?.grades,
      subjects: s.subject !== undefined ? [s.subject] : course?.subject !== undefined ? [course.subject] : undefined,
      course: ref("course", s.courseId),
      school: ref("org", s.schoolId),
      terms: s.termIds.map((id) => ref("academicSession", id)),
      periods: s.period === undefined ? undefined : [s.period],
    }) as OneRosterRecord;
  });
  const users = seed.people.map((p) => present({
    ...base(p),
    username: usernameOf(p),
    userIds: p.localId === undefined ? undefined : [{ type: "LocalId", identifier: p.localId }],
    enabledUser: true,
    givenName: p.givenName,
    familyName: p.familyName,
    middleName: p.middleName,
    roles: rolesOf(seed, p, ref),
    primaryOrg: p.schoolIds[0] === undefined ? ref("org", seed.id) : ref("org", p.schoolIds[0]),
    identifier: p.localId,
    email: p.email,
    agents: (p.role === "guardian" ? p.guardianOf ?? [] : p.role === "student" ? guardiansOf(p.id) : []).map((id) => ref("user", id)),
    grades: p.grade === undefined ? undefined : [p.grade],
  }) as OneRosterRecord);
  const enrollments = enrollmentsOf(seed).map((e) => {
    const person = people.get(e.personId)!;
    const status: SeedStatus = (e.section.status ?? "active") === "tobedeleted" || (person.status ?? "active") === "tobedeleted" ? "tobedeleted" : "active";
    return {
      sourcedId: e.id,
      status,
      dateLastModified: new Date(latest(modifiedOf(seed, e.section), modifiedOf(seed, person))).toISOString(),
      user: ref("user", e.personId),
      class: ref("class", e.section.id),
      school: ref("org", e.section.schoolId),
      role: e.role,
      primary: e.primary,
    } as OneRosterRecord;
  });
  return { orgs, academicSessions, courses, classes, users, enrollments };
}

/**
 * The fields the 1.2 information model defines for each collection, which `filter`, `sort` and
 * `fields` may name. A name outside these is an invalid field.
 */
export const COLLECTION_FIELDS: Readonly<Record<OneRosterCollection, readonly string[]>> = {
  orgs: ["sourcedId", "status", "dateLastModified", "metadata", "name", "type", "identifier", "parent", "children"],
  academicSessions: ["sourcedId", "status", "dateLastModified", "metadata", "title", "startDate", "endDate", "type", "parent", "children", "schoolYear"],
  courses: ["sourcedId", "status", "dateLastModified", "metadata", "title", "schoolYear", "courseCode", "grades", "subjects", "org", "subjectCodes", "resources"],
  classes: [
    "sourcedId", "status", "dateLastModified", "metadata", "title", "classCode", "classType", "location", "grades", "subjects", "course", "school",
    "terms", "subjectCodes", "periods", "resources",
  ],
  users: [
    "sourcedId", "status", "dateLastModified", "metadata", "userMasterIdentifier", "username", "userIds", "enabledUser", "givenName", "familyName",
    "middleName", "preferredFirstName", "preferredMiddleName", "preferredLastName", "pronouns", "roles", "userProfiles", "primaryOrg", "identifier",
    "email", "sms", "phone", "agents", "grades", "password", "resources",
  ],
  enrollments: ["sourcedId", "status", "dateLastModified", "metadata", "user", "class", "school", "role", "primary", "beginDate", "endDate"],
};

/** The JSON key wrapping one record of a collection, as `{"user": {...}}`. */
export const SINGULAR: Readonly<Record<OneRosterCollection, string>> = {
  orgs: "org",
  academicSessions: "academicSession",
  courses: "course",
  classes: "class",
  users: "user",
  enrollments: "enrollment",
};

/**
 * One record of the collection broken as real servers break them, for a `malformed-record` fault:
 * an org type in the wrong case, a US-style date, a course or enrollment missing a required
 * reference, a class with no terms, and a user in the 1.1 shape (`role` and `orgs`, no `roles`).
 */
export function malform(collection: OneRosterCollection, record: OneRosterRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(record);
  switch (collection) {
    case "orgs":
      copy.type = String(record.type).replace(/^./, (c) => c.toUpperCase());
      break;
    case "academicSessions": {
      const [y, m, d] = String(record.startDate).split("-");
      copy.startDate = `${m}/${d}/${y}`;
      break;
    }
    case "courses":
      delete copy.org;
      break;
    case "classes":
      delete copy.terms;
      break;
    case "users": {
      const roles = (record.roles as { role: string; org: unknown }[] | undefined) ?? [];
      delete copy.roles;
      copy.role = roles[0]?.role ?? "student";
      copy.orgs = roles.map((r) => r.org);
      break;
    }
    case "enrollments":
      delete copy.user;
      break;
  }
  return copy;
}
