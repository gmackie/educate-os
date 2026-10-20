import { DistrictDirectorySnapshot } from "@schoolos/contracts";
import { enroll, person } from "./builders";

const D = "dst_northfield";
const IDP = "https://idp.northfield.example";

/**
 * Northfield Public Schools: a synthetic district with a high school and a middle school, an
 * active fall term and a completed spring term. Every person here is invented.
 *
 * Deliberate edge cases:
 * - `prn_nf-morgan-lee` shares an email address and IdP subject with a Riverbend teacher. They are
 *   different principals, because identity is keyed by `(district, issuer, subject)`.
 * - The two Okafor siblings share a family email address, which therefore cannot be a key.
 * - `prn_nf-student-dmitri` was dropped from English 9: the enrollment is inactive, not deleted.
 * - Spring Biology is in a completed term, so its work is retained but no longer live.
 */
export const NORTHFIELD = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Northfield Public Schools (synthetic)",
    timeZone: "America/Detroit",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_nf-high", districtId: D, name: "Northfield High School", gradeBands: ["9-12"] },
    { id: "sch_nf-middle", districtId: D, name: "Northfield Middle School", gradeBands: ["6-8"] },
  ],
  terms: [
    { id: "trm_nf-2026-spring", districtId: D, name: "Spring 2026", startsOn: "2026-01-12", endsOn: "2026-06-12", state: "completed" },
    { id: "trm_nf-2026-fall", districtId: D, name: "Fall 2026", startsOn: "2026-08-31", endsOn: "2027-01-22", state: "active" },
  ],
  courses: [
    { id: "crs_nf-biology-1", districtId: D, title: "Biology I", subject: "science", gradeBand: "9-10" },
    { id: "crs_nf-english-9", districtId: D, title: "English 9", subject: "english-language-arts", gradeBand: "9" },
    { id: "crs_nf-us-history", districtId: D, title: "United States History", subject: "history-social-studies", gradeBand: "11" },
    { id: "crs_nf-math-7", districtId: D, title: "Mathematics 7", subject: "mathematics", gradeBand: "7" },
  ],
  offerings: [
    { id: "off_nf-bio-fall-p2", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-biology-1", sectionName: "Period 2" },
    { id: "off_nf-bio-spring-p4", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-spring", courseId: "crs_nf-biology-1", sectionName: "Period 4" },
    { id: "off_nf-eng9-fall-p3", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-english-9", sectionName: "Period 3" },
    { id: "off_nf-ushist-fall-p5", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-us-history", sectionName: "Period 5" },
    { id: "off_nf-math7-fall-p1", districtId: D, schoolId: "sch_nf-middle", termId: "trm_nf-2026-fall", courseId: "crs_nf-math-7", sectionName: "Period 1" },
  ],
  principals: [
    person(D, IDP, "prn_nf-district-admin", "staff", "Avery Admin", "nf-0001", "avery.admin@northfield.example"),
    person(D, IDP, "prn_nf-principal-high", "staff", "Jordan Principal", "nf-0002", "jordan.principal@northfield.example"),
    person(D, IDP, "prn_nf-morgan-lee", "staff", "Morgan Lee", "user-1042", "morgan.lee@teachers.example"),
    person(D, IDP, "prn_nf-teacher-rivera", "staff", "Sam Rivera", "nf-0101", "sam.rivera@northfield.example"),
    person(D, IDP, "prn_nf-teacher-chen", "staff", "Riley Chen", "nf-0102", "riley.chen@northfield.example"),
    person(D, IDP, "prn_nf-teacher-patel", "staff", "Casey Patel", "nf-0103", "casey.patel@northfield.example"),
    person(D, IDP, "prn_nf-student-amara", "student", "Amara Okafor", "nf-s-2001", "family.okafor@northfield.example"),
    person(D, IDP, "prn_nf-student-chidi", "student", "Chidi Okafor", "nf-s-2002", "family.okafor@northfield.example"),
    person(D, IDP, "prn_nf-student-dmitri", "student", "Dmitri Novak", "nf-s-2003"),
    person(D, IDP, "prn_nf-student-elena", "student", "Elena Sato", "nf-s-2004"),
    person(D, IDP, "prn_nf-student-felix", "student", "Felix Brandt", "nf-s-2005"),
  ],
  enrollments: [
    enroll(D, "enr_nf-01", "off_nf-bio-fall-p2", "prn_nf-morgan-lee", "teacher"),
    enroll(D, "enr_nf-02", "off_nf-bio-fall-p2", "prn_nf-student-amara", "student"),
    enroll(D, "enr_nf-03", "off_nf-bio-fall-p2", "prn_nf-student-dmitri", "student"),
    enroll(D, "enr_nf-04", "off_nf-bio-fall-p2", "prn_nf-student-elena", "student"),
    enroll(D, "enr_nf-05", "off_nf-bio-spring-p4", "prn_nf-morgan-lee", "teacher"),
    enroll(D, "enr_nf-06", "off_nf-bio-spring-p4", "prn_nf-student-amara", "student"),
    enroll(D, "enr_nf-07", "off_nf-eng9-fall-p3", "prn_nf-teacher-rivera", "teacher"),
    enroll(D, "enr_nf-08", "off_nf-eng9-fall-p3", "prn_nf-teacher-chen", "co-teacher"),
    enroll(D, "enr_nf-09", "off_nf-eng9-fall-p3", "prn_nf-student-amara", "student"),
    enroll(D, "enr_nf-10", "off_nf-eng9-fall-p3", "prn_nf-student-dmitri", "student", "inactive"),
    enroll(D, "enr_nf-11", "off_nf-eng9-fall-p3", "prn_nf-student-elena", "student"),
    enroll(D, "enr_nf-12", "off_nf-ushist-fall-p5", "prn_nf-teacher-chen", "teacher"),
    enroll(D, "enr_nf-13", "off_nf-ushist-fall-p5", "prn_nf-student-elena", "student"),
    enroll(D, "enr_nf-14", "off_nf-ushist-fall-p5", "prn_nf-student-dmitri", "student"),
    enroll(D, "enr_nf-15", "off_nf-math7-fall-p1", "prn_nf-teacher-patel", "teacher"),
    enroll(D, "enr_nf-16", "off_nf-math7-fall-p1", "prn_nf-student-chidi", "student"),
    enroll(D, "enr_nf-17", "off_nf-math7-fall-p1", "prn_nf-student-felix", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_nf-district-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: "prn_nf-principal-high", role: "school-admin", scope: { level: "school", districtId: D, schoolId: "sch_nf-high" }, source: "roster" },
    { principalId: "prn_nf-morgan-lee", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" }, source: "roster" },
    { principalId: "prn_nf-teacher-rivera", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" }, source: "roster" },
    { principalId: "prn_nf-teacher-chen", role: "co-teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" }, source: "roster" },
    { principalId: "prn_nf-teacher-chen", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-ushist-fall-p5" }, source: "roster" },
    { principalId: "prn_nf-teacher-patel", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-middle", offeringId: "off_nf-math7-fall-p1" }, source: "roster" },
  ],
});
