import type { DistrictDirectorySnapshot } from "@educateos/contracts";
import { CEDARVALLEY, CEDARVALLEY_GUARDIANS } from "./cedarvalley.ts";
import { HARBOR, HARBOR_GUARDIANS } from "./harbor.ts";
import { LAKESHORE, LAKESHORE_GUARDIANS } from "./lakeshore.ts";
import { NORTHFIELD } from "./northfield.ts";
import { PRAIRIE, PRAIRIE_GUARDIANS } from "./prairie.ts";
import type { DemoDistrict, DemoDistrictSlug } from "./profile.ts";
import { RIVERBEND } from "./riverbend.ts";
import { classroomSeed, type ClassroomSeed } from "./vendors/classroom.ts";
import { cleverSeed, type CleverSeed } from "./vendors/clever.ts";
import { districtSeed } from "./vendors/district-seed.ts";
import { oneRosterSeed, withStudentsRemoved, type OneRosterSeed } from "./vendors/oneroster.ts";

export { CEDARVALLEY, CEDARVALLEY_GUARDIANS } from "./cedarvalley.ts";
export { HARBOR, HARBOR_GUARDIANS } from "./harbor.ts";
export { LAKESHORE, LAKESHORE_GUARDIANS } from "./lakeshore.ts";
export { NORTHFIELD } from "./northfield.ts";
export { PRAIRIE, PRAIRIE_GUARDIANS } from "./prairie.ts";
export { RIVERBEND } from "./riverbend.ts";
export type * from "./profile.ts";
export type * from "./vendors/classroom.ts";
export type * from "./vendors/clever.ts";
export type * from "./vendors/oneroster.ts";
export { classroomSeed, cleverSeed, districtSeed, oneRosterSeed, withStudentsRemoved };
export type { DistrictSeedOptions, FakeDistrictSeed, FakePersonSeed } from "./vendors/district-seed.ts";
export { googleDemoPlan, type GoogleCoursePlan, type GoogleDemoPlan, type GoogleOrgUnitPlan, type GoogleUserPlan } from "./google-demo.ts";

/**
 * The six demo districts, in harness port order (Northfield on 4801 through Harbor on 4806). Each
 * runs as a fully isolated instance: no ID, issuer or identity link is shared between them, though
 * Morgan Lee's email and IdP subject are shared by Northfield and Riverbend, and one IdP subject by
 * two different students in Cedar Valley and Lakeshore.
 */
export const DEMO_DISTRICTS: readonly DemoDistrict[] = [
  {
    slug: "northfield",
    directory: NORTHFIELD,
    guardians: [],
    profile: { sso: "district-oidc", roster: "oneroster-csv", lms: "canvas-lti", gradeAuthority: "canvas" },
    harnessPort: 4801,
  },
  {
    slug: "riverbend",
    directory: RIVERBEND,
    guardians: [],
    profile: { sso: "district-oidc", roster: "oneroster-rest", lms: "lms-lite", gradeAuthority: "educateos" },
    harnessPort: 4802,
  },
  {
    slug: "prairie",
    directory: PRAIRIE,
    guardians: PRAIRIE_GUARDIANS,
    profile: { sso: "local", roster: "local", lms: "lms-lite", gradeAuthority: "educateos" },
    harnessPort: 4803,
  },
  {
    slug: "cedarvalley",
    directory: CEDARVALLEY,
    guardians: CEDARVALLEY_GUARDIANS,
    profile: { sso: "clever", roster: "clever", lms: "google-classroom", gradeAuthority: "google-classroom" },
    harnessPort: 4804,
    googleOrgUnit: "CedarValley",
  },
  {
    slug: "lakeshore",
    directory: LAKESHORE,
    guardians: LAKESHORE_GUARDIANS,
    profile: { sso: "classlink", roster: "oneroster-rest", lms: "schoology-lti", gradeAuthority: "schoology" },
    harnessPort: 4805,
  },
  {
    slug: "harbor",
    directory: HARBOR,
    guardians: HARBOR_GUARDIANS,
    profile: { sso: "google", roster: "google-classroom", lms: "google-classroom", gradeAuthority: "google-classroom" },
    harnessPort: 4806,
    googleOrgUnit: "Harbor",
  },
];

/** Every demo district's directory, in {@link DEMO_DISTRICTS} order. */
export const SYNTHETIC_DISTRICTS: readonly DistrictDirectorySnapshot[] = DEMO_DISTRICTS.map((d) => d.directory);

/** One demo district by slug. */
export function demoDistrict(slug: DemoDistrictSlug): DemoDistrict {
  return DEMO_DISTRICTS.find((d) => d.slug === slug)!;
}

/** The vendor-side records a district's integrations hold, for the provider fakes to serve. */
export interface VendorSeeds {
  /** For a district that signs in or rosters through Clever. */
  clever?: CleverSeed;
  /** For a district that rosters over OneRoster, as CSV or REST. */
  oneRoster?: OneRosterSeed;
  /** For a district with Google accounts in Classroom. */
  classroom?: ClassroomSeed;
}

/** The vendor seeds a demo district's profile calls for, each holding the same people as its directory. */
export function vendorSeeds(demo: DemoDistrict): VendorSeeds {
  const { sso, roster, lms } = demo.profile;
  return {
    ...(sso === "clever" || roster === "clever" ? { clever: cleverSeed(demo) } : {}),
    ...(roster === "oneroster-csv" || roster === "oneroster-rest" ? { oneRoster: oneRosterSeed(demo) } : {}),
    ...(roster === "google-classroom" || lms === "google-classroom" ? { classroom: classroomSeed(demo) } : {}),
  };
}

/**
 * Lakeshore's OneRoster server after a botched export dropped every high-school student: eight of
 * its ten students vanish at once. A sync must hold this for review rather than deactivate them.
 */
export function lakeshoreLargeRemoval(): OneRosterSeed {
  const high = new Set(LAKESHORE.offerings.filter((o) => o.schoolId === "sch_ls-high").map((o) => o.id));
  const removed = LAKESHORE.enrollments.filter((e) => e.role === "student" && high.has(e.offeringId)).map((e) => e.principalId);
  return withStudentsRemoved(oneRosterSeed(demoDistrict("lakeshore")), [...new Set(removed)]);
}
