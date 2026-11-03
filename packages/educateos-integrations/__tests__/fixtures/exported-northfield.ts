import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";

/** The classes the hand-written export carries. */
const OFFERINGS = new Set(["off_nf-bio-fall-p2", "off_nf-bio-spring-p4", "off_nf-eng9-fall-p3", "off_nf-ushist-fall-p5", "off_nf-math7-fall-p1"]);
/** The people the hand-written export carries. */
const PRINCIPALS = new Set([
  "prn_nf-district-admin", "prn_nf-principal-high", "prn_nf-morgan-lee", "prn_nf-teacher-rivera", "prn_nf-teacher-chen", "prn_nf-teacher-patel",
  "prn_nf-student-amara", "prn_nf-student-chidi", "prn_nf-student-dmitri", "prn_nf-student-elena", "prn_nf-student-felix",
]);

/**
 * The part of `NORTHFIELD` the synthetic OneRoster export (`northfield-export.ts`) mirrors: its high
 * and middle schools with the classes and people they had before the elementary school and the K-12
 * showcase classes joined the fixture (SCHO-322). An import of the export is checked against this.
 */
export const EXPORTED_NORTHFIELD = DistrictDirectorySnapshot.parse({
  ...NORTHFIELD,
  schools: NORTHFIELD.schools.filter((s) => s.id === "sch_nf-high" || s.id === "sch_nf-middle"),
  courses: NORTHFIELD.courses.filter((c) => NORTHFIELD.offerings.some((o) => OFFERINGS.has(o.id) && o.courseId === c.id)),
  offerings: NORTHFIELD.offerings.filter((o) => OFFERINGS.has(o.id)),
  principals: NORTHFIELD.principals.filter((p) => PRINCIPALS.has(p.id)),
  enrollments: NORTHFIELD.enrollments.filter((e) => OFFERINGS.has(e.offeringId) && PRINCIPALS.has(e.principalId)),
  roleAssignments: NORTHFIELD.roleAssignments.filter((r) => PRINCIPALS.has(r.principalId) && (r.scope.level !== "offering" || OFFERINGS.has(r.scope.offeringId))),
});
