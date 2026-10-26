import { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";
import { enroll, guardianOf, person, teaches } from "./builders.ts";

const D = "dst_prairie";
const IDP = "https://accounts.prairie.example";

/**
 * Prairie Co-op: a small learning co-op with no integrations at all. Accounts are local (the
 * issuer is EducateOS's own sign-in), the directory is kept by hand, and LMS-lite is the only
 * gradebook. It is the district a school with nothing to connect starts as. Every person here is
 * invented.
 *
 * Deliberate edge cases:
 * - The Hollis siblings and their parent share one family email address.
 * - Dana Hollis is a guardian principal with a confirmed relationship to each child.
 * - Every role is a `local-grant`, since there is no roster to source one.
 */
export const PRAIRIE = DistrictDirectorySnapshot.parse({
  district: {
    id: D,
    name: "Prairie Co-op (synthetic)",
    timeZone: "America/Denver",
    trustedIssuers: [IDP],
  },
  schools: [
    { id: "sch_pr-commons", districtId: D, name: "Prairie Co-op Commons", gradeBands: ["K-8"] },
    { id: "sch_pr-upper", districtId: D, name: "Prairie Co-op Upper School", gradeBands: ["9-12"] },
  ],
  terms: [
    { id: "trm_pr-2026-27", districtId: D, name: "2026-27 Co-op Year", startsOn: "2026-08-17", endsOn: "2027-05-21", state: "active" },
  ],
  courses: [
    { id: "crs_pr-life-science", districtId: D, title: "Life Science", subject: "science", gradeBand: "6-8" },
    { id: "crs_pr-writers-workshop", districtId: D, title: "Writers' Workshop", subject: "english-language-arts", gradeBand: "6-8" },
    { id: "crs_pr-plains-history", districtId: D, title: "Prairie and Plains History", subject: "history-social-studies", gradeBand: "9-12" },
    { id: "crs_pr-ceramics", districtId: D, title: "Ceramics", subject: "arts", gradeBand: "9-12" },
  ],
  offerings: [
    { id: "off_pr-lifesci-tue", districtId: D, schoolId: "sch_pr-commons", termId: "trm_pr-2026-27", courseId: "crs_pr-life-science", sectionName: "Tuesday Morning" },
    { id: "off_pr-writers-thu", districtId: D, schoolId: "sch_pr-commons", termId: "trm_pr-2026-27", courseId: "crs_pr-writers-workshop", sectionName: "Thursday Morning" },
    { id: "off_pr-history-mon", districtId: D, schoolId: "sch_pr-upper", termId: "trm_pr-2026-27", courseId: "crs_pr-plains-history", sectionName: "Monday Afternoon" },
    { id: "off_pr-ceramics-wed", districtId: D, schoolId: "sch_pr-upper", termId: "trm_pr-2026-27", courseId: "crs_pr-ceramics", sectionName: "Wednesday Studio" },
  ],
  principals: [
    person(D, IDP, "prn_pr-coordinator", "staff", "Hazel Brooks", "pr-local-0001", "hazel.brooks@prairie.example"),
    person(D, IDP, "prn_pr-teacher-lindqvist", "staff", "Erik Lindqvist", "pr-local-0101", "erik.lindqvist@prairie.example"),
    person(D, IDP, "prn_pr-teacher-adeyemi", "staff", "Funmi Adeyemi", "pr-local-0102", "funmi.adeyemi@prairie.example"),
    person(D, IDP, "prn_pr-student-wren", "student", "Wren Hollis", "pr-local-2001", "family.hollis@prairie.example"),
    person(D, IDP, "prn_pr-student-jasper", "student", "Jasper Hollis", "pr-local-2002", "family.hollis@prairie.example"),
    person(D, IDP, "prn_pr-student-maya", "student", "Maya Castellanos", "pr-local-2003"),
    person(D, IDP, "prn_pr-student-theo", "student", "Theo Grant", "pr-local-2004"),
    person(D, IDP, "prn_pr-guardian-hollis", "guardian", "Dana Hollis", "pr-local-3001", "family.hollis@prairie.example"),
  ],
  enrollments: [
    enroll(D, "enr_pr-01", "off_pr-lifesci-tue", "prn_pr-teacher-lindqvist", "teacher"),
    enroll(D, "enr_pr-02", "off_pr-lifesci-tue", "prn_pr-student-wren", "student"),
    enroll(D, "enr_pr-03", "off_pr-lifesci-tue", "prn_pr-student-jasper", "student"),
    enroll(D, "enr_pr-04", "off_pr-writers-thu", "prn_pr-teacher-adeyemi", "teacher"),
    enroll(D, "enr_pr-05", "off_pr-writers-thu", "prn_pr-student-wren", "student"),
    enroll(D, "enr_pr-06", "off_pr-writers-thu", "prn_pr-student-jasper", "student"),
    enroll(D, "enr_pr-07", "off_pr-history-mon", "prn_pr-teacher-lindqvist", "teacher"),
    enroll(D, "enr_pr-08", "off_pr-history-mon", "prn_pr-student-maya", "student"),
    enroll(D, "enr_pr-09", "off_pr-history-mon", "prn_pr-student-theo", "student"),
    enroll(D, "enr_pr-10", "off_pr-ceramics-wed", "prn_pr-teacher-adeyemi", "teacher"),
    enroll(D, "enr_pr-11", "off_pr-ceramics-wed", "prn_pr-student-maya", "student"),
    enroll(D, "enr_pr-12", "off_pr-ceramics-wed", "prn_pr-student-theo", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_pr-coordinator", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    teaches(D, "prn_pr-teacher-lindqvist", "teacher", "sch_pr-commons", "off_pr-lifesci-tue", "local-grant"),
    teaches(D, "prn_pr-teacher-adeyemi", "teacher", "sch_pr-commons", "off_pr-writers-thu", "local-grant"),
    teaches(D, "prn_pr-teacher-lindqvist", "teacher", "sch_pr-upper", "off_pr-history-mon", "local-grant"),
    teaches(D, "prn_pr-teacher-adeyemi", "teacher", "sch_pr-upper", "off_pr-ceramics-wed", "local-grant"),
  ],
});

/** Prairie's guardian relationships: Dana Hollis, for each child. */
export const PRAIRIE_GUARDIANS: readonly GuardianRelationship[] = [
  guardianOf(D, "grl_pr-hollis-wren", "prn_pr-guardian-hollis", "prn_pr-student-wren", "prn_pr-coordinator"),
  guardianOf(D, "grl_pr-hollis-jasper", "prn_pr-guardian-hollis", "prn_pr-student-jasper", "prn_pr-coordinator"),
].map((r) => GuardianRelationship.parse(r));
