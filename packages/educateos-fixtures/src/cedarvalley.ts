import { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";
import { enroll, guardianOf, person, teaches } from "./builders.ts";

const D = "dst_cedarvalley";
const IDP = "https://clever.cedarvalley.example";

/**
 * Cedar Valley USD: a district that signs in and rosters through Clever and teaches in Google
 * Classroom. Each IdP subject is the person's Clever user ID, as Clever SSO asserts it, so the
 * Clever seed (`vendors/clever.ts`) and this directory name the same people. Every person here is
 * invented.
 *
 * Deliberate edge cases:
 * - Dana Whitaker teaches at both schools: Earth Science 8 at the middle school and Algebra I at
 *   the high school.
 * - The Nguyen twins share one family email address, and their parent is a guardian of both.
 * - Sofia Marquez was dropped from Earth Science 8 mid-term: the enrollment is inactive, not
 *   deleted, and Clever's section no longer lists her.
 * - `prn_cv-student-rowan` has the same IdP subject as `prn_ls-student-sky` in Lakeshore, under a
 *   different issuer. They are different people, so nothing may key on the subject alone.
 */
export const CEDARVALLEY = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Cedar Valley USD (synthetic)",
    timeZone: "America/Los_Angeles",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_cv-middle", districtId: D, name: "Cedar Valley Middle School", gradeBands: ["6-8"] },
    { id: "sch_cv-high", districtId: D, name: "Cedar Valley High School", gradeBands: ["9-12"] },
  ],
  terms: [
    { id: "trm_cv-2026-fall", districtId: D, name: "Fall 2026", startsOn: "2026-08-19", endsOn: "2026-12-18", state: "active" },
  ],
  courses: [
    { id: "crs_cv-earth-science-8", districtId: D, title: "Earth Science 8", subject: "science", gradeBand: "8" },
    { id: "crs_cv-english-8", districtId: D, title: "English 8", subject: "english-language-arts", gradeBand: "8" },
    { id: "crs_cv-world-history-7", districtId: D, title: "World History 7", subject: "history-social-studies", gradeBand: "7" },
    { id: "crs_cv-algebra-1", districtId: D, title: "Algebra I", subject: "mathematics", gradeBand: "9" },
  ],
  offerings: [
    { id: "off_cv-earthsci-p1", districtId: D, schoolId: "sch_cv-middle", termId: "trm_cv-2026-fall", courseId: "crs_cv-earth-science-8", sectionName: "Period 1" },
    { id: "off_cv-eng8-p2", districtId: D, schoolId: "sch_cv-middle", termId: "trm_cv-2026-fall", courseId: "crs_cv-english-8", sectionName: "Period 2" },
    { id: "off_cv-whist7-p4", districtId: D, schoolId: "sch_cv-middle", termId: "trm_cv-2026-fall", courseId: "crs_cv-world-history-7", sectionName: "Period 4" },
    { id: "off_cv-alg1-p3", districtId: D, schoolId: "sch_cv-high", termId: "trm_cv-2026-fall", courseId: "crs_cv-algebra-1", sectionName: "Period 3" },
  ],
  principals: [
    person(D, IDP, "prn_cv-district-admin", "staff", "Elaine Park", "6650c1a0e1b2c3d4e5f60001", "elaine.park@cedarvalley.example"),
    person(D, IDP, "prn_cv-teacher-whitaker", "staff", "Dana Whitaker", "6650c1a0e1b2c3d4e5f60101", "dana.whitaker@cedarvalley.example"),
    person(D, IDP, "prn_cv-teacher-ferreira", "staff", "Luis Ferreira", "6650c1a0e1b2c3d4e5f60102", "luis.ferreira@cedarvalley.example"),
    person(D, IDP, "prn_cv-student-an", "student", "An Nguyen", "6650c1a0e1b2c3d4e5f62001", "family.nguyen@cedarvalley.example"),
    person(D, IDP, "prn_cv-student-bao", "student", "Bao Nguyen", "6650c1a0e1b2c3d4e5f62002", "family.nguyen@cedarvalley.example"),
    person(D, IDP, "prn_cv-student-rowan", "student", "Rowan Ellis", "6650c1a0e1b2c3d4e5f62003"),
    person(D, IDP, "prn_cv-student-sofia", "student", "Sofia Marquez", "6650c1a0e1b2c3d4e5f62004"),
    person(D, IDP, "prn_cv-student-isaac", "student", "Isaac Thornton", "6650c1a0e1b2c3d4e5f62005"),
    person(D, IDP, "prn_cv-student-leila", "student", "Leila Farouk", "6650c1a0e1b2c3d4e5f62006"),
    person(D, IDP, "prn_cv-guardian-nguyen", "guardian", "Thu Nguyen", "6650c1a0e1b2c3d4e5f63001", "family.nguyen@cedarvalley.example"),
  ],
  enrollments: [
    enroll(D, "enr_cv-01", "off_cv-earthsci-p1", "prn_cv-teacher-whitaker", "teacher"),
    enroll(D, "enr_cv-02", "off_cv-earthsci-p1", "prn_cv-student-an", "student"),
    enroll(D, "enr_cv-03", "off_cv-earthsci-p1", "prn_cv-student-bao", "student"),
    enroll(D, "enr_cv-04", "off_cv-earthsci-p1", "prn_cv-student-rowan", "student"),
    enroll(D, "enr_cv-05", "off_cv-earthsci-p1", "prn_cv-student-sofia", "student", "inactive"),
    enroll(D, "enr_cv-06", "off_cv-eng8-p2", "prn_cv-teacher-ferreira", "teacher"),
    enroll(D, "enr_cv-07", "off_cv-eng8-p2", "prn_cv-student-an", "student"),
    enroll(D, "enr_cv-08", "off_cv-eng8-p2", "prn_cv-student-bao", "student"),
    enroll(D, "enr_cv-09", "off_cv-eng8-p2", "prn_cv-student-rowan", "student"),
    enroll(D, "enr_cv-10", "off_cv-eng8-p2", "prn_cv-student-sofia", "student"),
    enroll(D, "enr_cv-11", "off_cv-whist7-p4", "prn_cv-teacher-ferreira", "teacher"),
    enroll(D, "enr_cv-12", "off_cv-whist7-p4", "prn_cv-student-an", "student"),
    enroll(D, "enr_cv-13", "off_cv-whist7-p4", "prn_cv-student-rowan", "student"),
    enroll(D, "enr_cv-14", "off_cv-whist7-p4", "prn_cv-student-sofia", "student"),
    enroll(D, "enr_cv-15", "off_cv-alg1-p3", "prn_cv-teacher-whitaker", "teacher"),
    enroll(D, "enr_cv-16", "off_cv-alg1-p3", "prn_cv-student-isaac", "student"),
    enroll(D, "enr_cv-17", "off_cv-alg1-p3", "prn_cv-student-leila", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_cv-district-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    teaches(D, "prn_cv-teacher-whitaker", "teacher", "sch_cv-middle", "off_cv-earthsci-p1"),
    teaches(D, "prn_cv-teacher-whitaker", "teacher", "sch_cv-high", "off_cv-alg1-p3"),
    teaches(D, "prn_cv-teacher-ferreira", "teacher", "sch_cv-middle", "off_cv-eng8-p2"),
    teaches(D, "prn_cv-teacher-ferreira", "teacher", "sch_cv-middle", "off_cv-whist7-p4"),
  ],
});

/** Cedar Valley's guardian relationships: Thu Nguyen, for each twin. */
export const CEDARVALLEY_GUARDIANS: readonly GuardianRelationship[] = [
  guardianOf(D, "grl_cv-nguyen-an", "prn_cv-guardian-nguyen", "prn_cv-student-an", "prn_cv-district-admin"),
  guardianOf(D, "grl_cv-nguyen-bao", "prn_cv-guardian-nguyen", "prn_cv-student-bao", "prn_cv-district-admin"),
].map((r) => GuardianRelationship.parse(r));
