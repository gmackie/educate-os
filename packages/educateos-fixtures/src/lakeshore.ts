import { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";
import { enroll, guardianOf, person, teaches } from "./builders.ts";

const D = "dst_lakeshore";
const IDP = "https://launchpad.lakeshore.example";

/**
 * Lakeshore Schools: a district that signs in through ClassLink, rosters over ClassLink's
 * OneRoster 1.2 REST API and teaches in Schoology over LTI. Each IdP subject is the user's
 * OneRoster `username`, as ClassLink asserts it. It is the largest synthetic district, so a roster
 * that suddenly drops most of its students (`lakeshoreLargeRemoval` in `vendors/oneroster.ts`)
 * looks like the mistake it is. Every person here is invented.
 *
 * Deliberate edge cases:
 * - Gus Moreno was dropped from Chemistry mid-term: inactive here, `tobedeleted` in OneRoster.
 * - Civics is co-taught: Malcolm Doyle is its co-teacher.
 * - Keiko Ito is a guardian of Hana Ito, linked as her OneRoster agent.
 * - `prn_ls-student-sky` has the same IdP subject as `prn_cv-student-rowan` in Cedar Valley, under
 *   a different issuer. They are different people.
 */
export const LAKESHORE = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Lakeshore Schools (synthetic)",
    timeZone: "America/New_York",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_ls-high", districtId: D, name: "Lakeshore High School", gradeBands: ["9-12"] },
    { id: "sch_ls-elementary", districtId: D, name: "Lakeshore Elementary", gradeBands: ["K-5"] },
  ],
  terms: [
    { id: "trm_ls-2026-s1", districtId: D, name: "Semester 1 2026-27", startsOn: "2026-09-02", endsOn: "2027-01-27", state: "active" },
  ],
  courses: [
    { id: "crs_ls-chemistry", districtId: D, title: "Chemistry", subject: "science", gradeBand: "11" },
    { id: "crs_ls-english-11", districtId: D, title: "English 11", subject: "english-language-arts", gradeBand: "11" },
    { id: "crs_ls-civics", districtId: D, title: "Civics", subject: "history-social-studies", gradeBand: "12" },
    { id: "crs_ls-art-3", districtId: D, title: "Art 3", subject: "arts", gradeBand: "3" },
  ],
  offerings: [
    { id: "off_ls-chem-p1", districtId: D, schoolId: "sch_ls-high", termId: "trm_ls-2026-s1", courseId: "crs_ls-chemistry", sectionName: "Period 1" },
    { id: "off_ls-eng11-p2", districtId: D, schoolId: "sch_ls-high", termId: "trm_ls-2026-s1", courseId: "crs_ls-english-11", sectionName: "Period 2" },
    { id: "off_ls-civics-p6", districtId: D, schoolId: "sch_ls-high", termId: "trm_ls-2026-s1", courseId: "crs_ls-civics", sectionName: "Period 6" },
    { id: "off_ls-art3-rm12", districtId: D, schoolId: "sch_ls-elementary", termId: "trm_ls-2026-s1", courseId: "crs_ls-art-3", sectionName: "Room 12" },
  ],
  principals: [
    person(D, IDP, "prn_ls-district-admin", "staff", "Grace Whitfield", "ls-a-01", "grace.whitfield@lakeshore.example"),
    person(D, IDP, "prn_ls-principal-high", "staff", "Omar Reyes", "ls-a-02", "omar.reyes@lakeshore.example"),
    person(D, IDP, "prn_ls-teacher-raman", "staff", "Priya Raman", "ls-t-301", "priya.raman@lakeshore.example"),
    person(D, IDP, "prn_ls-teacher-doyle", "staff", "Malcolm Doyle", "ls-t-302", "malcolm.doyle@lakeshore.example"),
    person(D, IDP, "prn_ls-teacher-albright", "staff", "Ines Albright", "ls-t-303", "ines.albright@lakeshore.example"),
    person(D, IDP, "prn_ls-student-ava", "student", "Ava Lindgren", "ls-s-4001"),
    person(D, IDP, "prn_ls-student-ben", "student", "Ben Okoro", "ls-s-4002"),
    person(D, IDP, "prn_ls-student-chloe", "student", "Chloe Dubois", "ls-s-4003"),
    person(D, IDP, "prn_ls-student-dev", "student", "Dev Malhotra", "ls-s-4004"),
    person(D, IDP, "prn_ls-student-eli", "student", "Eli Stern", "ls-s-4005"),
    person(D, IDP, "prn_ls-student-fatima", "student", "Fatima Zahra", "ls-s-4006"),
    person(D, IDP, "prn_ls-student-gus", "student", "Gus Moreno", "ls-s-4007"),
    person(D, IDP, "prn_ls-student-sky", "student", "Sky Abara", "6650c1a0e1b2c3d4e5f62003"),
    person(D, IDP, "prn_ls-student-hana", "student", "Hana Ito", "ls-s-5001"),
    person(D, IDP, "prn_ls-student-iker", "student", "Iker Ruiz", "ls-s-5002"),
    person(D, IDP, "prn_ls-guardian-ito", "guardian", "Keiko Ito", "ls-g-6001", "keiko.ito@family.lakeshore.example"),
  ],
  enrollments: [
    enroll(D, "enr_ls-01", "off_ls-chem-p1", "prn_ls-teacher-raman", "teacher"),
    enroll(D, "enr_ls-02", "off_ls-chem-p1", "prn_ls-student-ava", "student"),
    enroll(D, "enr_ls-03", "off_ls-chem-p1", "prn_ls-student-ben", "student"),
    enroll(D, "enr_ls-04", "off_ls-chem-p1", "prn_ls-student-chloe", "student"),
    enroll(D, "enr_ls-05", "off_ls-chem-p1", "prn_ls-student-dev", "student"),
    enroll(D, "enr_ls-06", "off_ls-chem-p1", "prn_ls-student-gus", "student", "inactive"),
    enroll(D, "enr_ls-07", "off_ls-chem-p1", "prn_ls-student-sky", "student"),
    enroll(D, "enr_ls-08", "off_ls-eng11-p2", "prn_ls-teacher-doyle", "teacher"),
    enroll(D, "enr_ls-09", "off_ls-eng11-p2", "prn_ls-student-ava", "student"),
    enroll(D, "enr_ls-10", "off_ls-eng11-p2", "prn_ls-student-ben", "student"),
    enroll(D, "enr_ls-11", "off_ls-eng11-p2", "prn_ls-student-chloe", "student"),
    enroll(D, "enr_ls-12", "off_ls-eng11-p2", "prn_ls-student-dev", "student"),
    enroll(D, "enr_ls-13", "off_ls-eng11-p2", "prn_ls-student-eli", "student"),
    enroll(D, "enr_ls-14", "off_ls-eng11-p2", "prn_ls-student-fatima", "student"),
    enroll(D, "enr_ls-15", "off_ls-eng11-p2", "prn_ls-student-gus", "student"),
    enroll(D, "enr_ls-16", "off_ls-eng11-p2", "prn_ls-student-sky", "student"),
    enroll(D, "enr_ls-17", "off_ls-civics-p6", "prn_ls-teacher-raman", "teacher"),
    enroll(D, "enr_ls-18", "off_ls-civics-p6", "prn_ls-teacher-doyle", "co-teacher"),
    enroll(D, "enr_ls-19", "off_ls-civics-p6", "prn_ls-student-eli", "student"),
    enroll(D, "enr_ls-20", "off_ls-civics-p6", "prn_ls-student-fatima", "student"),
    enroll(D, "enr_ls-21", "off_ls-civics-p6", "prn_ls-student-gus", "student"),
    enroll(D, "enr_ls-22", "off_ls-civics-p6", "prn_ls-student-sky", "student"),
    enroll(D, "enr_ls-23", "off_ls-art3-rm12", "prn_ls-teacher-albright", "teacher"),
    enroll(D, "enr_ls-24", "off_ls-art3-rm12", "prn_ls-student-hana", "student"),
    enroll(D, "enr_ls-25", "off_ls-art3-rm12", "prn_ls-student-iker", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_ls-district-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "roster" },
    { principalId: "prn_ls-principal-high", role: "school-admin", scope: { level: "school", districtId: D, schoolId: "sch_ls-high" }, source: "roster" },
    teaches(D, "prn_ls-teacher-raman", "teacher", "sch_ls-high", "off_ls-chem-p1"),
    teaches(D, "prn_ls-teacher-doyle", "teacher", "sch_ls-high", "off_ls-eng11-p2"),
    teaches(D, "prn_ls-teacher-raman", "teacher", "sch_ls-high", "off_ls-civics-p6"),
    teaches(D, "prn_ls-teacher-doyle", "co-teacher", "sch_ls-high", "off_ls-civics-p6"),
    teaches(D, "prn_ls-teacher-albright", "teacher", "sch_ls-elementary", "off_ls-art3-rm12"),
  ],
});

/** Lakeshore's guardian relationships: Keiko Ito, for Hana. */
export const LAKESHORE_GUARDIANS: readonly GuardianRelationship[] = [
  guardianOf(D, "grl_ls-ito-hana", "prn_ls-guardian-ito", "prn_ls-student-hana", "prn_ls-district-admin"),
].map((r) => GuardianRelationship.parse(r));
