import { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";
import { enroll, guardianOf, person, teaches } from "./builders.ts";

const D = "dst_harbor";
const IDP = "https://google.harbor.example";

/**
 * Harbor Charter: a charter school with no SIS. People sign in with their Google Workspace
 * accounts, and Google Classroom is both the roster and the LMS. Each IdP subject is the person's
 * Google user ID as the synthetic Google sign-in asserts it, and each email is their Workspace
 * account, so the Classroom seed (`vendors/classroom.ts`) names exactly these people. In the real
 * demo tenant Google assigns its own user IDs, so a live run links by those instead. Every person
 * here is invented.
 *
 * Deliberate edge cases:
 * - Ruth Delaney teaches at both campuses.
 * - Quentin Hale was dropped from US Government mid-term: inactive here, and absent from the
 *   Classroom roster.
 * - Ayo Fontaine's guardian relationship is still pending: recorded by the admin, not yet
 *   confirmed, so it grants nothing. Classroom has no guardian an admin could import.
 */
export const HARBOR = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Harbor Charter (synthetic)",
    timeZone: "America/Los_Angeles",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_hb-middle", districtId: D, name: "Harbor Charter Middle Campus", gradeBands: ["6-8"] },
    { id: "sch_hb-high", districtId: D, name: "Harbor Charter High Campus", gradeBands: ["9-12"] },
  ],
  terms: [
    { id: "trm_hb-2026-27", districtId: D, name: "2026-27", startsOn: "2026-08-24", endsOn: "2027-06-11", state: "active" },
  ],
  courses: [
    { id: "crs_hb-marine-science", districtId: D, title: "Marine Science", subject: "science", gradeBand: "10" },
    { id: "crs_hb-composition", districtId: D, title: "Composition", subject: "english-language-arts", gradeBand: "10" },
    { id: "crs_hb-us-government", districtId: D, title: "US Government", subject: "history-social-studies", gradeBand: "12" },
    { id: "crs_hb-math-7", districtId: D, title: "Math 7", subject: "mathematics", gradeBand: "7" },
  ],
  offerings: [
    { id: "off_hb-marine-b1", districtId: D, schoolId: "sch_hb-high", termId: "trm_hb-2026-27", courseId: "crs_hb-marine-science", sectionName: "Block 1" },
    { id: "off_hb-comp-b2", districtId: D, schoolId: "sch_hb-high", termId: "trm_hb-2026-27", courseId: "crs_hb-composition", sectionName: "Block 2" },
    { id: "off_hb-gov-b3", districtId: D, schoolId: "sch_hb-high", termId: "trm_hb-2026-27", courseId: "crs_hb-us-government", sectionName: "Block 3" },
    { id: "off_hb-math7-b1", districtId: D, schoolId: "sch_hb-middle", termId: "trm_hb-2026-27", courseId: "crs_hb-math-7", sectionName: "Block 1" },
  ],
  principals: [
    person(D, IDP, "prn_hb-school-admin", "staff", "Marisol Vega", "104000000000000000001", "hb-school-admin@harbor.example"),
    person(D, IDP, "prn_hb-teacher-asante", "staff", "Kwame Asante", "104000000000000000101", "hb-teacher-asante@harbor.example"),
    person(D, IDP, "prn_hb-teacher-delaney", "staff", "Ruth Delaney", "104000000000000000102", "hb-teacher-delaney@harbor.example"),
    person(D, IDP, "prn_hb-student-nia", "student", "Nia Fontaine", "104000000000000002001", "hb-student-nia@harbor.example"),
    person(D, IDP, "prn_hb-student-owen", "student", "Owen Kerr", "104000000000000002002", "hb-student-owen@harbor.example"),
    person(D, IDP, "prn_hb-student-pia", "student", "Pia Lund", "104000000000000002003", "hb-student-pia@harbor.example"),
    person(D, IDP, "prn_hb-student-quentin", "student", "Quentin Hale", "104000000000000002004", "hb-student-quentin@harbor.example"),
    person(D, IDP, "prn_hb-student-rosa", "student", "Rosa Iqbal", "104000000000000002005", "hb-student-rosa@harbor.example"),
    person(D, IDP, "prn_hb-student-sami", "student", "Sami Torres", "104000000000000002006", "hb-student-sami@harbor.example"),
    person(D, IDP, "prn_hb-guardian-fontaine", "guardian", "Ayo Fontaine", "104000000000000003001", "ayo.fontaine@family.harbor.example"),
  ],
  enrollments: [
    enroll(D, "enr_hb-01", "off_hb-marine-b1", "prn_hb-teacher-asante", "teacher"),
    enroll(D, "enr_hb-02", "off_hb-marine-b1", "prn_hb-student-nia", "student"),
    enroll(D, "enr_hb-03", "off_hb-marine-b1", "prn_hb-student-owen", "student"),
    enroll(D, "enr_hb-04", "off_hb-marine-b1", "prn_hb-student-pia", "student"),
    enroll(D, "enr_hb-05", "off_hb-comp-b2", "prn_hb-teacher-delaney", "teacher"),
    enroll(D, "enr_hb-06", "off_hb-comp-b2", "prn_hb-student-nia", "student"),
    enroll(D, "enr_hb-07", "off_hb-comp-b2", "prn_hb-student-owen", "student"),
    enroll(D, "enr_hb-08", "off_hb-comp-b2", "prn_hb-student-pia", "student"),
    enroll(D, "enr_hb-09", "off_hb-comp-b2", "prn_hb-student-quentin", "student"),
    enroll(D, "enr_hb-10", "off_hb-gov-b3", "prn_hb-teacher-asante", "teacher"),
    enroll(D, "enr_hb-11", "off_hb-gov-b3", "prn_hb-student-pia", "student"),
    enroll(D, "enr_hb-12", "off_hb-gov-b3", "prn_hb-student-quentin", "student", "inactive"),
    enroll(D, "enr_hb-13", "off_hb-math7-b1", "prn_hb-teacher-delaney", "teacher"),
    enroll(D, "enr_hb-14", "off_hb-math7-b1", "prn_hb-student-rosa", "student"),
    enroll(D, "enr_hb-15", "off_hb-math7-b1", "prn_hb-student-sami", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_hb-school-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    teaches(D, "prn_hb-teacher-asante", "teacher", "sch_hb-high", "off_hb-marine-b1"),
    teaches(D, "prn_hb-teacher-delaney", "teacher", "sch_hb-high", "off_hb-comp-b2"),
    teaches(D, "prn_hb-teacher-asante", "teacher", "sch_hb-high", "off_hb-gov-b3"),
    teaches(D, "prn_hb-teacher-delaney", "teacher", "sch_hb-middle", "off_hb-math7-b1"),
  ],
});

/** Harbor's guardian relationships: Ayo Fontaine's, for Nia, still awaiting confirmation. */
export const HARBOR_GUARDIANS: readonly GuardianRelationship[] = [
  guardianOf(D, "grl_hb-fontaine-nia", "prn_hb-guardian-fontaine", "prn_hb-student-nia", "prn_hb-school-admin", "pending"),
].map((r) => GuardianRelationship.parse(r));
