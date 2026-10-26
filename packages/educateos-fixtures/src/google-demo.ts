// What the Google Workspace for Education demo tenant should hold, derived from the demo districts
// with Google accounts. `scripts/demo/seed-google-demo.ts` makes the tenant match it; this module
// only describes it, so it can be tested without Google.
import type { DemoDistrict, DemoDistrictSlug } from "./profile.ts";
import { classroomSeed } from "./vendors/classroom.ts";

/** An organizational unit to create. */
export interface GoogleOrgUnitPlan {
  /** Its full path, such as `/Harbor/Staff`. */
  path: string;
  /** Its name, the last path segment. */
  name: string;
  /** Its parent's path: `/` for a district's top-level unit. */
  parentPath: string;
  description: string;
}

/** A Workspace account to create. */
export interface GoogleUserPlan {
  district: DemoDistrictSlug;
  /** The principal it is. */
  fixtureId: string;
  primaryEmail: string;
  givenName: string;
  familyName: string;
  kind: "staff" | "student";
  orgUnitPath: string;
}

/** A Classroom course to create, owned by its lead teacher. */
export interface GoogleCoursePlan {
  district: DemoDistrictSlug;
  /** The offering it is. */
  fixtureId: string;
  /** Its domain-scoped alias, `d:<offering ID>`, by which a rerun finds it. */
  alias: string;
  name: string;
  section: string;
  ownerEmail: string;
  /** The other teachers. */
  coTeacherEmails: string[];
  studentEmails: string[];
}

/** Everything the demo tenant should hold. */
export interface GoogleDemoPlan {
  domain: string;
  orgUnits: GoogleOrgUnitPlan[];
  users: GoogleUserPlan[];
  courses: GoogleCoursePlan[];
}

/**
 * The demo tenant's contents for every district with a `googleOrgUnit`: its organizational units
 * (`/<unit>`, `/<unit>/Staff`, `/<unit>/Students`), one account per staff member and student, and
 * the Classroom courses of `classroomSeed` with their rosters. Everything is keyed on fixture IDs.
 */
export function googleDemoPlan(domain: string, districts: readonly DemoDistrict[]): GoogleDemoPlan {
  const plan: GoogleDemoPlan = { domain, orgUnits: [], users: [], courses: [] };
  for (const demo of districts) {
    const unit = demo.googleOrgUnit;
    if (unit === undefined) continue;
    const description = `EducateOS synthetic demo district ${demo.directory.district.id}`;
    plan.orgUnits.push(
      { path: `/${unit}`, name: unit, parentPath: "/", description },
      { path: `/${unit}/Staff`, name: "Staff", parentPath: `/${unit}`, description: `${description}: staff (18 or older)` },
      { path: `/${unit}/Students`, name: "Students", parentPath: `/${unit}`, description: `${description}: students (under 18)` },
    );
    const seed = classroomSeed(demo, domain);
    const email = new Map(seed.users.map((u) => [u.id, u.primaryEmail]));
    for (const user of seed.users) {
      plan.users.push({
        district: demo.slug,
        fixtureId: user.fixtureId,
        primaryEmail: user.primaryEmail,
        givenName: user.name.givenName,
        familyName: user.name.familyName,
        kind: user.kind,
        orgUnitPath: `/${unit}/${user.kind === "staff" ? "Staff" : "Students"}`,
      });
    }
    for (const course of seed.courses) {
      const members = (list: typeof seed.teachers) => list.filter((m) => m.courseId === course.id).map((m) => email.get(m.userId)!);
      plan.courses.push({
        district: demo.slug,
        fixtureId: course.fixtureId,
        alias: course.alias,
        name: course.name,
        section: course.section,
        ownerEmail: email.get(course.ownerId)!,
        coTeacherEmails: members(seed.teachers).filter((e) => e !== email.get(course.ownerId)),
        studentEmails: members(seed.students),
      });
    }
  }
  return plan;
}
