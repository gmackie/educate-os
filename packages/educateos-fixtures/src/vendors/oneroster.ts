// A demo district as OneRoster 1.2 rostering REST JSON (the ClassLink profile serves the same
// collections), for a OneRoster fake (SCHO-201) to serve. Each record's `sourcedId` is its fixture
// ID, and each user's `username` is their IdP subject, which is where ClassLink SSO and the
// district IdPs put it.
import type { Subject } from "@educateos/contracts";
import type { DemoDistrict } from "../profile.ts";
import { SEEDED_AT, gradesOf, indexDirectory, splitName, subjectOf } from "./shared.ts";

/** A OneRoster reference to another record. */
export interface OneRosterRef {
  href: string;
  sourcedId: string;
  type: "org" | "academicSession" | "course" | "class" | "user";
}

interface Base {
  sourcedId: string;
  status: "active" | "tobedeleted";
  dateLastModified: string;
}

/** A OneRoster 1.2 org. */
export interface OneRosterOrg extends Base {
  name: string;
  type: "district" | "school";
  identifier: string;
  parent?: OneRosterRef;
}

/** A OneRoster 1.2 academic session. */
export interface OneRosterAcademicSession extends Base {
  title: string;
  type: "term";
  startDate: string;
  endDate: string;
  schoolYear: string;
}

/** A OneRoster 1.2 course. */
export interface OneRosterCourse extends Base {
  title: string;
  courseCode: string;
  grades: string[];
  subjects: string[];
  org: OneRosterRef;
}

/** A OneRoster 1.2 class. */
export interface OneRosterClass extends Base {
  title: string;
  classCode: string;
  classType: "scheduled";
  grades: string[];
  subjects: string[];
  course: OneRosterRef;
  school: OneRosterRef;
  terms: OneRosterRef[];
}

/** A OneRoster 1.2 user, with its roles. */
export interface OneRosterUser extends Base {
  enabledUser: boolean;
  username: string;
  userIds: { type: string; identifier: string }[];
  givenName: string;
  familyName: string;
  email?: string;
  grades: string[];
  roles: { roleType: "primary" | "secondary"; role: OneRosterUserRole; org: OneRosterRef }[];
  primaryOrg: OneRosterRef;
  agents?: OneRosterRef[];
}

/** The OneRoster roles the seed assigns. */
export type OneRosterUserRole = "districtAdministrator" | "principal" | "teacher" | "student" | "guardian";

/** A OneRoster 1.2 enrollment. */
export interface OneRosterEnrollment extends Base {
  user: OneRosterRef;
  class: OneRosterRef;
  school: OneRosterRef;
  role: "teacher" | "student";
  primary?: boolean;
}

/** The rostering collections a OneRoster fake serves for one district, by collection name. */
export interface OneRosterSeed {
  /** The server origin every `href` points at. */
  origin: string;
  orgs: OneRosterOrg[];
  academicSessions: OneRosterAcademicSession[];
  courses: OneRosterCourse[];
  classes: OneRosterClass[];
  users: OneRosterUser[];
  enrollments: OneRosterEnrollment[];
}

/** Subject names `subjectFor` in `@educateos/integrations` maps back to each EducateOS subject. */
const SUBJECT_NAME: Readonly<Record<Subject, string>> = {
  "english-language-arts": "English Language Arts",
  science: "Science",
  "history-social-studies": "Social Studies",
  mathematics: "Mathematics",
  arts: "Arts",
  "world-languages": "World Languages",
  "computer-science": "Computer Science",
  "health-physical-education": "Physical Education",
  "social-emotional-learning": "Other",
  other: "Other",
};

/** OneRoster's grade codes: `KG`, then two-digit grades. */
const gradeCodes = (band: string) => gradesOf(band).map((g) => (g === "K" ? "KG" : g.padStart(2, "0")));

const PATHS = { org: "orgs", academicSession: "academicSessions", course: "courses", class: "classes", user: "users" } as const;

/**
 * A demo district as its OneRoster server holds it. A dropped enrollment is `tobedeleted`, staff
 * hold the roles their role assignments and enrollments imply, and each guardian is listed as a
 * `guardian` user linked to their child through `agents`.
 */
export function oneRosterSeed(demo: DemoDistrict, origin = `https://oneroster.${demo.slug}.example`): OneRosterSeed {
  const { directory, guardians } = demo;
  const lookup = indexDirectory(directory);
  const ref = (type: OneRosterRef["type"], sourcedId: string): OneRosterRef => ({
    href: `${origin}/ims/oneroster/rostering/v1p2/${PATHS[type]}/${sourcedId}`,
    sourcedId,
    type,
  });
  const base = (sourcedId: string, status: Base["status"] = "active"): Base => ({ sourcedId, status, dateLastModified: SEEDED_AT });
  const districtRef = ref("org", directory.district.id);

  const rolesOf = (principalId: string): OneRosterUser["roles"] => {
    const principal = lookup.principal.get(principalId)!;
    const roles: { role: OneRosterUserRole; org: string }[] = [];
    if (principal.kind === "guardian") roles.push({ role: "guardian", org: directory.district.id });
    for (const r of directory.roleAssignments.filter((r) => r.principalId === principalId)) {
      if (r.role === "district-admin") roles.push({ role: "districtAdministrator", org: directory.district.id });
      if (r.role === "school-admin" && r.scope.level === "school") roles.push({ role: "principal", org: r.scope.schoolId });
    }
    const role = principal.kind === "student" ? "student" : "teacher";
    for (const school of lookup.schoolsOf(principalId)) {
      const enrolledThere = directory.enrollments.some((e) => e.principalId === principalId && lookup.offering.get(e.offeringId)!.schoolId === school);
      if (enrolledThere) roles.push({ role, org: school });
    }
    return roles.map((r, i) => ({ roleType: i === 0 ? "primary" : "secondary", role: r.role, org: ref("org", r.org) }));
  };

  return {
    origin,
    orgs: [
      { ...base(directory.district.id), name: directory.district.name, type: "district", identifier: directory.district.id },
      ...directory.schools.map((s): OneRosterOrg => ({ ...base(s.id), name: s.name, type: "school", identifier: s.id, parent: districtRef })),
    ],
    academicSessions: directory.terms.map((t) => ({
      ...base(t.id),
      title: t.name,
      type: "term",
      startDate: t.startsOn,
      endDate: t.endsOn,
      schoolYear: t.endsOn.slice(0, 4),
    })),
    courses: directory.courses.map((c) => ({
      ...base(c.id),
      title: c.title,
      courseCode: c.id,
      grades: gradeCodes(c.gradeBand),
      subjects: [SUBJECT_NAME[c.subject]],
      org: districtRef,
    })),
    classes: directory.offerings.map((o) => {
      const course = lookup.course.get(o.courseId)!;
      return {
        ...base(o.id),
        title: o.sectionName,
        classCode: o.id,
        classType: "scheduled",
        grades: gradeCodes(course.gradeBand),
        subjects: [SUBJECT_NAME[course.subject]],
        course: ref("course", course.id),
        school: ref("org", o.schoolId),
        terms: [ref("academicSession", o.termId)],
      };
    }),
    users: directory.principals.map((p): OneRosterUser => {
      const roles = rolesOf(p.id);
      const grade = p.kind === "student" ? lookup.gradeOf(p.id) : undefined;
      const agents = guardians
        .filter((g) => g.guardianPrincipalId === p.id || g.studentPrincipalId === p.id)
        .map((g) => ref("user", g.guardianPrincipalId === p.id ? g.studentPrincipalId : g.guardianPrincipalId));
      const { first, last } = splitName(p.displayName);
      return {
        ...base(p.id, p.status === "active" ? "active" : "tobedeleted"),
        enabledUser: true,
        username: subjectOf(p),
        userIds: [{ type: "idp", identifier: subjectOf(p) }],
        givenName: first,
        familyName: last,
        ...(p.email === undefined ? {} : { email: p.email }),
        grades: grade === undefined ? [] : gradeCodes(grade),
        roles,
        primaryOrg: roles[0]?.org ?? districtRef,
        ...(agents.length === 0 ? {} : { agents }),
      };
    }),
    enrollments: directory.enrollments.map((e) => ({
      ...base(e.id, e.status === "active" ? "active" : "tobedeleted"),
      user: ref("user", e.principalId),
      class: ref("class", e.offeringId),
      school: ref("org", lookup.offering.get(e.offeringId)!.schoolId),
      role: e.role === "student" ? "student" : "teacher",
      ...(e.role === "student" ? {} : { primary: e.role === "teacher" }),
    })),
  };
}

/**
 * The same seed after a botched SIS export: every listed student is simply missing, with their
 * enrollments, rather than marked `tobedeleted`. A complete sync of it would deactivate them all,
 * which is what a large-removal guard must stop and ask about.
 */
export function withStudentsRemoved(seed: OneRosterSeed, removed: readonly string[]): OneRosterSeed {
  const gone = new Set(removed);
  return {
    ...seed,
    users: seed.users.filter((u) => !gone.has(u.sourcedId)),
    enrollments: seed.enrollments.filter((e) => !gone.has(e.user.sourcedId)),
  };
}
