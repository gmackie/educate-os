// A demo district as Google Classroom (and the Workspace directory behind it) holds it, for a
// Classroom fake (SCHO-201) to serve and for `scripts/demo/seed-google-demo.ts` to create in the
// Google demo tenant. Both read this one seed, so the fake and the real tenant hold the same people.
import type { DemoDistrict } from "../profile.ts";
import { idBody, indexDirectory, splitName, stableDigits, subjectOf } from "./shared.ts";

/** A Workspace user, with the Classroom `UserProfile` fields EducateOS reads. */
export interface ClassroomUser {
  /** The Google user ID. */
  id: string;
  /** The account's primary email: the fixture ID's body at the seed's domain. */
  primaryEmail: string;
  name: { givenName: string; familyName: string; fullName: string };
  /** The principal this account is. */
  fixtureId: string;
  /** Whether the account is staff or a student, which decides its organizational unit. */
  kind: "staff" | "student";
}

/** A Classroom course: one active offering. */
export interface ClassroomCourse {
  /** The Classroom course ID. */
  id: string;
  /** The domain-scoped alias that keys it on its fixture ID: `d:<offering ID>`. */
  alias: string;
  name: string;
  section: string;
  /** The Google user ID of the owner: the offering's lead teacher. */
  ownerId: string;
  courseState: "ACTIVE";
  /** The offering this course is. */
  fixtureId: string;
}

/** A course membership, as `courses.teachers` and `courses.students` list it. */
export interface ClassroomMember {
  courseId: string;
  userId: string;
}

/** Everything a Classroom fake serves for one district. */
export interface ClassroomSeed {
  /** The Workspace domain of every account. */
  domain: string;
  users: ClassroomUser[];
  courses: ClassroomCourse[];
  /** Every teacher of each course, the owner included. */
  teachers: ClassroomMember[];
  /** Every current student of each course. A dropped student is not listed. */
  students: ClassroomMember[];
}

/**
 * A demo district as Classroom holds it: one Workspace account for each staff member and student
 * (guardians have none), and one course for each offering in an active term that has a lead
 * teacher. When the district signs in with Google, each account's ID is the person's IdP subject;
 * otherwise it is derived from the fixture ID. Account emails are the fixture ID's body at
 * `domain` (`hb-teacher-asante@<domain>`), so they never depend on the directory's display email.
 */
export function classroomSeed(demo: DemoDistrict, domain = `${demo.slug}.example`): ClassroomSeed {
  const { directory } = demo;
  const lookup = indexDirectory(directory);
  const userId = (principalId: string) => {
    const principal = lookup.principal.get(principalId)!;
    return demo.profile.sso === "google" ? subjectOf(principal) : stableDigits(`google:${principal.id}`, 21);
  };

  const users = directory.principals
    .filter((p) => p.kind === "staff" || p.kind === "student")
    .map((p): ClassroomUser => {
      const { first, last } = splitName(p.displayName);
      return {
        id: userId(p.id),
        primaryEmail: `${idBody(p.id)}@${domain}`,
        name: { givenName: first, familyName: last, fullName: p.displayName },
        fixtureId: p.id,
        kind: p.kind === "student" ? "student" : "staff",
      };
    });

  const active = new Set(directory.terms.filter((t) => t.state === "active").map((t) => t.id));
  const courses: ClassroomCourse[] = [];
  const teachers: ClassroomMember[] = [];
  const students: ClassroomMember[] = [];
  for (const offering of directory.offerings.filter((o) => active.has(o.termId))) {
    const members = directory.enrollments.filter((e) => e.offeringId === offering.id && e.status === "active");
    const lead = members.find((e) => e.role === "teacher");
    if (lead === undefined) continue;
    const id = stableDigits(`classroom:${offering.id}`, 12);
    courses.push({
      id,
      alias: `d:${offering.id}`,
      name: lookup.course.get(offering.courseId)!.title,
      section: offering.sectionName,
      ownerId: userId(lead.principalId),
      courseState: "ACTIVE",
      fixtureId: offering.id,
    });
    for (const e of members) (e.role === "student" ? students : teachers).push({ courseId: id, userId: userId(e.principalId) });
  }
  return { domain, users, courses, teachers, students };
}
