// Google Classroom as a roster source, for a district whose roster is Classroom (no SIS). Classroom
// courses, teachers and students are mapped into the OneRoster row model, so they pass through the
// same import as every other source: identity linking, quarantine, preview and all-or-nothing
// apply. New for SCHO-77.
//
// Classroom has no schools, terms, catalog courses or grade levels, so the district's connection
// configuration supplies them: the term every course is taught in, and the schools courses belong
// to, each with its grades. A course is a class; its name, per school, is the catalog course.
import { RosterIdentityMapping } from "@educateos/contracts";
import { CLASSROOM_ISSUER } from "@educateos/lti";
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";
import type { OneRosterIssue } from "../oneroster/feed.ts";
import { ROW_SCHEMAS, SourcedId } from "../oneroster/spec.ts";
import type { OneRosterFile } from "../oneroster/spec.ts";
import { numberRows } from "../oneroster/sync.ts";
import type { RosterBatch, RosterMirror, RosterSource } from "../oneroster/sync.ts";
import type { ClassroomMember, GoogleClassroomClient } from "./client.ts";

/**
 * How a Classroom roster relates to the IdP: Google's OpenID issuer, with each user's Google user
 * ID as the subject (the row model's `username`). The district must trust the issuer.
 *
 * Google does not document that a Classroom user ID equals the OpenID `sub`; the Directory API's
 * user ID is the same number in practice. A live run must confirm it (see the design record).
 */
export const CLASSROOM_IDENTITY: RosterIdentityMapping = RosterIdentityMapping.parse({
  issuer: CLASSROOM_ISSUER,
  subject: { field: "username" },
});

const GradeCode = z.string().regex(/^(KG|0[1-9]|1[0-2])$/, "is not a grade code KG or 01 to 12");
// Only `d:` aliases: a `p:` alias is visible only to the Cloud project that made it.
const CourseKey = z.string().regex(/^(\d{1,32}|d:.{1,255})$/, "is not a Classroom course ID or d: alias");
const Domain = z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "is not a lowercase domain name");
const IsoDate = z.iso.date();

/** A school Classroom courses are assigned to. */
export const ClassroomSchool = z.strictObject({
  /** Its stable key, which the directory's school is derived from. */
  sourcedId: SourcedId,
  name: z.string().min(1).max(200),
  /** The grades it teaches, as OneRoster codes. Its courses are recorded as covering them. */
  grades: z.array(GradeCode).min(1),
  /** The courses taught here, by Classroom course ID or alias (`d:<SIS section ID>`). */
  courses: z.array(CourseKey).max(10_000).default([]),
});

/** The district's Classroom roster configuration. Holds no secret. */
export const ClassroomRosterConfig = z.strictObject({
  /** The term every imported course is taught in. Classroom has no terms of its own. */
  term: z.strictObject({ sourcedId: SourcedId, title: z.string().min(1).max(200), startDate: IsoDate, endDate: IsoDate }),
  /** The schools, at least one. */
  schools: z.array(ClassroomSchool).min(1).max(500),
  /** The school of a course no school lists. Without one, such a course is an error that blocks apply. */
  defaultSchool: SourcedId.optional(),
  /**
   * The Workspace domains whose accounts are imported. A roster member from any other domain (a
   * guest teacher, a consumer Gmail account) is left out with a warning, since an imported account
   * can sign in. Needs `classroom.profile.emails`. When absent, every member is imported.
   */
  domains: z.array(Domain).min(1).max(50).optional(),
}).check((ctx) => {
  const ids = ctx.value.schools.map((s) => s.sourcedId);
  if (new Set(ids).size !== ids.length) ctx.issues.push({ code: "custom", input: ids, message: "two schools share a sourcedId" });
  const listed = ctx.value.schools.flatMap((s) => s.courses);
  if (new Set(listed).size !== listed.length) ctx.issues.push({ code: "custom", input: listed, message: "a course is listed under two schools" });
  if (ctx.value.defaultSchool !== undefined && !ids.includes(ctx.value.defaultSchool)) {
    ctx.issues.push({ code: "custom", input: ctx.value.defaultSchool, message: "the default school is not one of the schools" });
  }
});
/** A Classroom roster configuration, as given. */
export type ClassroomRosterConfigInput = z.input<typeof ClassroomRosterConfig>;
/** A Classroom roster configuration. */
export type ClassroomRosterConfig = z.infer<typeof ClassroomRosterConfig>;

/**
 * A roster source reading every course in a Google Workspace domain through domain-wide
 * delegation. It reads complete rosters only: Classroom has no change feed EducateOS can poll, so
 * a complete sync on the roster schedule is what catches a dropped student (who is deactivated,
 * not deleted, by the import).
 *
 * Only `ACTIVE` courses are read. A course that stops being active (archived, suspended) leaves the
 * feed, so its offering stays as it was and its enrollments go inactive.
 *
 * Classroom's teacher and student lists decide who is staff and who is a student. A person who
 * teaches one course and is a student in another (a teacher in a staff-development class) holds
 * both roles, and the import quarantines them for an administrator.
 *
 * Import with {@link CLASSROOM_IDENTITY}.
 */
export function classroomRosterSource(client: GoogleClassroomClient, config: ClassroomRosterConfigInput): RosterSource {
  const parsed = ClassroomRosterConfig.safeParse(config);
  if (!parsed.success) throw new RosterSyncError("internal-error", `Classroom roster config is invalid: ${z.prettifyError(parsed.error)}`);
  return {
    kind: "google-classroom",
    format: "rest",
    modes: ["complete"],
    read: async (request) => {
      if (request.mode !== "complete") throw new RosterSyncError("delta-unsupported", "Classroom is read whole");
      return readClassroom(client, parsed.data);
    },
  };
}

type Rows = Record<OneRosterFile, Record<string, unknown>[]>;

async function readClassroom(client: GoogleClassroomClient, config: ClassroomRosterConfig): Promise<RosterBatch> {
  const issues: OneRosterIssue[] = [];
  const rows = Object.fromEntries(
    ["orgs.csv", "academicSessions.csv", "courses.csv", "classes.csv", "users.csv", "roles.csv", "enrollments.csv"].map((f) => [f, []]),
  ) as unknown as Rows;

  const courses = await client.listCourses(["ACTIVE"]);
  for (const bad of courses.invalid) {
    issues.push({ severity: "error", file: "classes.csv", row: bad.index + 1, message: `Classroom listed a course EducateOS cannot read (${bad.message})` });
  }
  const sorted = courses.records.toSorted((a, b) => compare(a.id, b.id));

  // A course's school: the one listing its ID or one of its aliases, else the default.
  const schoolOfKey = new Map(config.schools.flatMap((s) => s.courses.map((key) => [key, s.sourcedId] as const)));
  const wantsAliases = config.schools.some((s) => s.courses.some((key) => key.includes(":")));
  const schoolOf = new Map<string, string | undefined>();
  const conflicting = new Set<string>();
  for (const course of sorted) {
    const named = new Set<string>();
    const byId = schoolOfKey.get(course.id);
    if (byId !== undefined) named.add(byId);
    if (wantsAliases) {
      for (const alias of await client.listAliases(course.id)) {
        const school = schoolOfKey.get(alias);
        if (school !== undefined) named.add(school);
      }
    }
    if (named.size > 1) conflicting.add(course.id);
    schoolOf.set(course.id, named.size === 1 ? [...named][0] : named.size === 0 ? config.defaultSchool : undefined);
  }

  rows["academicSessions.csv"].push({ sourcedId: config.term.sourcedId, status: "active", title: config.term.title, type: "term", startDate: config.term.startDate, endDate: config.term.endDate });
  const usedSchools = new Set<string>();
  const catalog = new Set<string>();
  const users = new Map<string, { member: ClassroomMember; roles: Map<string, "teacher" | "student"> }>();

  const inDomain = (member: ClassroomMember) => {
    if (config.domains === undefined) return true;
    const email = member.profile?.emailAddress?.toLowerCase();
    return email !== undefined && config.domains.includes(email.slice(email.lastIndexOf("@") + 1));
  };

  for (const course of sorted) {
    const school = schoolOf.get(course.id);
    const courseSourcedId = await catalogCourseId(school ?? "", course.name);
    if (school === undefined) {
      issues.push({
        severity: "error", file: "classes.csv", sourcedId: course.id, column: "schoolSourcedId",
        message: conflicting.has(course.id)
          ? `Classroom course ${course.id} (${course.name}) is named under more than one school`
          : `Classroom course ${course.id} (${course.name}) is listed under no school, and there is no default school`,
      });
      continue;
    }
    usedSchools.add(school);
    const grades = config.schools.find((s) => s.sourcedId === school)!.grades;
    // Sections of one course (Block 1, Block 2) share its catalog course.
    if (!catalog.has(courseSourcedId)) {
      catalog.add(courseSourcedId);
      rows["courses.csv"].push({ sourcedId: courseSourcedId, status: "active", title: course.name.slice(0, 200), grades, orgSourcedId: school, subjects: [course.name], subjectCodes: [] });
    }
    rows["classes.csv"].push({
      sourcedId: course.id,
      status: "active",
      title: (course.section?.trim() || course.name).slice(0, 100),
      grades,
      courseSourcedId,
      classType: "scheduled",
      schoolSourcedId: school,
      termSourcedIds: [config.term.sourcedId],
    });
    for (const role of ["teacher", "student"] as const) {
      const read = role === "teacher" ? await client.listTeachers(course.id) : await client.listStudents(course.id);
      for (const bad of read.invalid) {
        issues.push({ severity: "error", file: "enrollments.csv", sourcedId: course.id, message: `Classroom listed a ${role} of course ${course.id} EducateOS cannot read (${bad.message})` });
      }
      for (const member of read.records.toSorted((a, b) => compare(a.userId, b.userId))) {
        if (!inDomain(member)) {
          issues.push({ severity: "warning", file: "enrollments.csv", sourcedId: course.id, message: `a ${role} of course ${course.id} is outside the district's Workspace domains and is left out` });
          continue;
        }
        const user = users.get(member.userId) ?? { member, roles: new Map() };
        users.set(member.userId, user);
        if (!user.roles.has(school)) user.roles.set(school, role);
        else if (user.roles.get(school) !== role) user.roles.set(`${school}\u0000${role}`, role);
        rows["enrollments.csv"].push({
          sourcedId: `${course.id}:${role}:${member.userId}`,
          status: "active",
          classSourcedId: course.id,
          schoolSourcedId: school,
          userSourcedId: member.userId,
          role,
          ...(role === "teacher" ? { primary: member.userId === course.ownerId } : {}),
        });
      }
    }
  }

  for (const s of config.schools) {
    if (usedSchools.has(s.sourcedId)) rows["orgs.csv"].push({ sourcedId: s.sourcedId, status: "active", name: s.name, type: "school" });
  }
  for (const [userId, { member, roles }] of [...users].toSorted(([a], [b]) => compare(a, b))) {
    const name = nameOf(member);
    rows["users.csv"].push({
      sourcedId: userId,
      status: "active",
      enabledUser: true,
      username: userId,
      userIds: [{ type: "google", identifier: userId }],
      givenName: name.given,
      familyName: name.family,
      ...(member.profile?.emailAddress === undefined ? {} : { email: member.profile.emailAddress }),
      grades: [],
    });
    let first = true;
    for (const [key, role] of roles) {
      rows["roles.csv"].push({ status: "active", userSourcedId: userId, roleType: first ? "primary" : "secondary", role, orgSourcedId: key.split("\u0000")[0]! });
      first = false;
    }
  }

  // Every row is checked against the same schemas a CSV or REST row is.
  const valid = {} as Record<OneRosterFile, unknown[]>;
  for (const [file, list] of Object.entries(rows) as [OneRosterFile, Record<string, unknown>[]][]) {
    valid[file] = [];
    for (const [index, row] of list.entries()) {
      const result = (ROW_SCHEMAS[file] as z.ZodType).safeParse(row);
      if (result.success) {
        valid[file].push(result.data);
        continue;
      }
      for (const issue of result.error.issues) {
        issues.push({
          severity: "error",
          file,
          row: index + 1,
          ...(typeof row.sourcedId === "string" ? { sourcedId: row.sourcedId } : {}),
          column: String(issue.path[0]),
          message: issue.message,
        });
      }
    }
  }
  return { mode: "complete", feed: numberRows(valid as RosterMirror), issues };
}

/** A member's name as given and family names. Google omits a part it does not have. */
function nameOf(member: ClassroomMember): { given: string; family: string } {
  const name = member.profile?.name;
  const [first = "", ...rest] = (name?.fullName ?? "").trim().split(/\s+/);
  const given = name?.givenName?.trim() || first;
  const family = name?.familyName?.trim() || rest.join(" ") || given;
  return { given: given.slice(0, 100), family: family.slice(0, 100) };
}

/** The catalog course of a Classroom course: its name at its school, as a stable opaque key. */
async function catalogCourseId(school: string, name: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([school, name.trim().toLowerCase()]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `gc-course-${Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
