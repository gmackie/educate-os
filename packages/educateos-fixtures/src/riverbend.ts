import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { enroll, person } from "./builders.ts";

const D = "dst_riverbend";
const IDP = "https://login.riverbend.example";

/**
 * Riverbend Unified: the second synthetic district, deliberately shaped differently from
 * Northfield (a K-8 school, an arts course, a different IdP) so code that only works for one
 * district's layout shows up. Every person here is invented.
 *
 * `prn_rb-morgan-lee` has the same email address and IdP subject as `prn_nf-morgan-lee` in
 * Northfield, under a different issuer and district. Nothing may treat them as one person.
 */
export const RIVERBEND = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Riverbend Unified (synthetic)",
    timeZone: "America/Chicago",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_rb-high", districtId: D, name: "Riverbend High School", gradeBands: ["9-12"] },
    { id: "sch_rb-k8", districtId: D, name: "Willow Creek K-8", gradeBands: ["K-8"] },
  ],
  terms: [
    { id: "trm_rb-2026-27", districtId: D, name: "2026-27 School Year", startsOn: "2026-08-24", endsOn: "2027-06-04", state: "active" },
  ],
  courses: [
    { id: "crs_rb-biology", districtId: D, title: "Biology", subject: "science", gradeBand: "9-12" },
    { id: "crs_rb-english-10", districtId: D, title: "English 10", subject: "english-language-arts", gradeBand: "10" },
    { id: "crs_rb-world-history", districtId: D, title: "World History", subject: "history-social-studies", gradeBand: "10" },
    { id: "crs_rb-visual-arts-6", districtId: D, title: "Visual Arts 6", subject: "arts", gradeBand: "6" },
  ],
  offerings: [
    { id: "off_rb-bio-a", districtId: D, schoolId: "sch_rb-high", termId: "trm_rb-2026-27", courseId: "crs_rb-biology", sectionName: "Section A" },
    { id: "off_rb-eng10-b", districtId: D, schoolId: "sch_rb-high", termId: "trm_rb-2026-27", courseId: "crs_rb-english-10", sectionName: "Section B" },
    { id: "off_rb-whist-a", districtId: D, schoolId: "sch_rb-high", termId: "trm_rb-2026-27", courseId: "crs_rb-world-history", sectionName: "Section A" },
    { id: "off_rb-arts6-1", districtId: D, schoolId: "sch_rb-k8", termId: "trm_rb-2026-27", courseId: "crs_rb-visual-arts-6", sectionName: "Homeroom 6-1" },
  ],
  principals: [
    person(D, IDP, "prn_rb-district-admin", "staff", "Quinn Okoye", "rb-a-01", "quinn.okoye@riverbend.example"),
    person(D, IDP, "prn_rb-morgan-lee", "staff", "Morgan Lee", "user-1042", "morgan.lee@teachers.example"),
    person(D, IDP, "prn_rb-teacher-haddad", "staff", "Noor Haddad", "rb-t-11", "noor.haddad@riverbend.example"),
    person(D, IDP, "prn_rb-teacher-silva", "staff", "Tomás Silva", "rb-t-12", "tomas.silva@riverbend.example"),
    person(D, IDP, "prn_rb-student-ines", "student", "Inés Moreau", "rb-s-501"),
    person(D, IDP, "prn_rb-student-kai", "student", "Kai Nakamura", "rb-s-502"),
    person(D, IDP, "prn_rb-student-lena", "student", "Lena Fischer", "rb-s-503"),
    person(D, IDP, "prn_rb-student-milo", "student", "Milo Andersen", "rb-s-601"),
  ],
  enrollments: [
    enroll(D, "enr_rb-01", "off_rb-bio-a", "prn_rb-morgan-lee", "teacher"),
    enroll(D, "enr_rb-02", "off_rb-bio-a", "prn_rb-student-ines", "student"),
    enroll(D, "enr_rb-03", "off_rb-bio-a", "prn_rb-student-kai", "student"),
    enroll(D, "enr_rb-04", "off_rb-eng10-b", "prn_rb-teacher-haddad", "teacher"),
    enroll(D, "enr_rb-05", "off_rb-eng10-b", "prn_rb-student-kai", "student"),
    enroll(D, "enr_rb-06", "off_rb-eng10-b", "prn_rb-student-lena", "student"),
    enroll(D, "enr_rb-07", "off_rb-whist-a", "prn_rb-teacher-haddad", "teacher"),
    enroll(D, "enr_rb-08", "off_rb-whist-a", "prn_rb-student-ines", "student"),
    enroll(D, "enr_rb-09", "off_rb-whist-a", "prn_rb-student-lena", "student"),
    enroll(D, "enr_rb-10", "off_rb-arts6-1", "prn_rb-teacher-silva", "teacher"),
    enroll(D, "enr_rb-11", "off_rb-arts6-1", "prn_rb-student-milo", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_rb-district-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: "prn_rb-morgan-lee", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_rb-high", offeringId: "off_rb-bio-a" }, source: "roster" },
    { principalId: "prn_rb-teacher-haddad", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_rb-high", offeringId: "off_rb-eng10-b" }, source: "roster" },
    { principalId: "prn_rb-teacher-haddad", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_rb-high", offeringId: "off_rb-whist-a" }, source: "roster" },
    { principalId: "prn_rb-teacher-silva", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_rb-k8", offeringId: "off_rb-arts6-1" }, source: "roster" },
  ],
});
