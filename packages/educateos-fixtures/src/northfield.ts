import { DistrictDirectorySnapshot, GuardianRelationship } from "@educateos/contracts";
import { enroll, guardianOf, person, teaches } from "./builders.ts";

const D = "dst_northfield";
const IDP = "https://idp.northfield.example";

/**
 * Northfield Public Schools: a synthetic K-12 district with an elementary, a middle and a high
 * school, an active fall term and a completed spring term. Every class of the fall term has at
 * least three students, so each grade band (K-2, 3-5, 6-8, 9-12) can show a full class
 * (`NORTHFIELD_SHOWCASE`). Every person here is invented.
 *
 * Deliberate edge cases:
 * - `prn_nf-morgan-lee` shares an email address and IdP subject with a Riverbend teacher. They are
 *   different principals, because identity is keyed by `(district, issuer, subject)`.
 * - The two Okafor siblings share a family email address, which therefore cannot be a key.
 * - `prn_nf-student-dmitri` was dropped from English 9: the enrollment is inactive, not deleted.
 * - Spring Biology is in a completed term, so its work is retained but no longer live.
 * - Each guardian in {@link NORTHFIELD_GUARDIANS} has two children in different schools: Rosa
 *   Delgado a first grader and a tenth grader, Kwame Mensah a fourth grader and an eighth grader.
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
    { id: "sch_nf-elem", districtId: D, name: "Northfield Elementary School", gradeBands: ["K-5"] },
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
    { id: "crs_nf-english-8", districtId: D, title: "English 8", subject: "english-language-arts", gradeBand: "8" },
    { id: "crs_nf-world-history-7", districtId: D, title: "World History 7", subject: "history-social-studies", gradeBand: "7" },
    { id: "crs_nf-k-science", districtId: D, title: "Kindergarten Science: Weather Watchers", subject: "science", gradeBand: "K" },
    { id: "crs_nf-g1-reading", districtId: D, title: "Grade 1 Reading Foundations", subject: "english-language-arts", gradeBand: "1" },
    { id: "crs_nf-g1-math", districtId: D, title: "Grade 1 Mathematics", subject: "mathematics", gradeBand: "1" },
    { id: "crs_nf-g4-ela", districtId: D, title: "Grade 4 English Language Arts", subject: "english-language-arts", gradeBand: "4" },
    { id: "crs_nf-g4-math", districtId: D, title: "Grade 4 Mathematics", subject: "mathematics", gradeBand: "4" },
    { id: "crs_nf-g5-science", districtId: D, title: "Grade 5 Science", subject: "science", gradeBand: "5" },
  ],
  offerings: [
    { id: "off_nf-bio-fall-p2", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-biology-1", sectionName: "Period 2" },
    { id: "off_nf-bio-spring-p4", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-spring", courseId: "crs_nf-biology-1", sectionName: "Period 4" },
    { id: "off_nf-eng9-fall-p3", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-english-9", sectionName: "Period 3" },
    { id: "off_nf-ushist-fall-p5", districtId: D, schoolId: "sch_nf-high", termId: "trm_nf-2026-fall", courseId: "crs_nf-us-history", sectionName: "Period 5" },
    { id: "off_nf-math7-fall-p1", districtId: D, schoolId: "sch_nf-middle", termId: "trm_nf-2026-fall", courseId: "crs_nf-math-7", sectionName: "Period 1" },
    { id: "off_nf-eng8-fall-p2", districtId: D, schoolId: "sch_nf-middle", termId: "trm_nf-2026-fall", courseId: "crs_nf-english-8", sectionName: "Period 2" },
    { id: "off_nf-whist7-fall-p4", districtId: D, schoolId: "sch_nf-middle", termId: "trm_nf-2026-fall", courseId: "crs_nf-world-history-7", sectionName: "Period 4" },
    { id: "off_nf-ksci-fall-r4", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-k-science", sectionName: "Room 4" },
    { id: "off_nf-g1read-fall-r7", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-g1-reading", sectionName: "Room 7" },
    { id: "off_nf-g1math-fall-r7", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-g1-math", sectionName: "Room 7" },
    { id: "off_nf-g4ela-fall-r12", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-g4-ela", sectionName: "Room 12" },
    { id: "off_nf-g4math-fall-r12", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-g4-math", sectionName: "Room 12" },
    { id: "off_nf-g5sci-fall-lab", districtId: D, schoolId: "sch_nf-elem", termId: "trm_nf-2026-fall", courseId: "crs_nf-g5-science", sectionName: "Science Lab" },
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
    // Elementary and middle-school staff.
    person(D, IDP, "prn_nf-teacher-marsh", "staff", "Lena Marsh", "nf-0104", "lena.marsh@northfield.example"),
    person(D, IDP, "prn_nf-teacher-yazzie", "staff", "Daniel Yazzie", "nf-0105", "daniel.yazzie@northfield.example"),
    person(D, IDP, "prn_nf-teacher-alsayed", "staff", "Fatima Al-Sayed", "nf-0106", "fatima.alsayed@northfield.example"),
    person(D, IDP, "prn_nf-teacher-johnson", "staff", "Marcus Johnson", "nf-0107", "marcus.johnson@northfield.example"),
    person(D, IDP, "prn_nf-teacher-kowalski", "staff", "Hannah Kowalski", "nf-0108", "hannah.kowalski@northfield.example"),
    person(D, IDP, "prn_nf-teacher-ortega", "staff", "Tomás Ortega", "nf-0109", "tomas.ortega@northfield.example"),
    // Kindergarten.
    person(D, IDP, "prn_nf-student-sofia", "student", "Sofia Ramírez", "nf-s-2006"),
    person(D, IDP, "prn_nf-student-noah", "student", "Noah Kim", "nf-s-2007"),
    person(D, IDP, "prn_nf-student-aiyana", "student", "Aiyana Begay", "nf-s-2008"),
    // Grade 1.
    person(D, IDP, "prn_nf-student-mateo", "student", "Mateo Delgado", "nf-s-2009"),
    person(D, IDP, "prn_nf-student-priya", "student", "Priya Natarajan", "nf-s-2010"),
    person(D, IDP, "prn_nf-student-jonah", "student", "Jonah Fischer", "nf-s-2011"),
    // Grade 4.
    person(D, IDP, "prn_nf-student-abena", "student", "Abena Mensah", "nf-s-2012"),
    person(D, IDP, "prn_nf-student-diego", "student", "Diego Hernández", "nf-s-2013"),
    person(D, IDP, "prn_nf-student-hana", "student", "Hana Suzuki", "nf-s-2014"),
    // Grade 5.
    person(D, IDP, "prn_nf-student-omar", "student", "Omar Haddad", "nf-s-2015"),
    person(D, IDP, "prn_nf-student-talia", "student", "Talia Goldberg", "nf-s-2016"),
    person(D, IDP, "prn_nf-student-elijah", "student", "Elijah Brooks", "nf-s-2017"),
    // Grades 7 and 8.
    person(D, IDP, "prn_nf-student-kofi", "student", "Kofi Mensah", "nf-s-2018"),
    person(D, IDP, "prn_nf-student-maya", "student", "Maya Thompson", "nf-s-2019"),
    person(D, IDP, "prn_nf-student-ravi", "student", "Ravi Shah", "nf-s-2020"),
    person(D, IDP, "prn_nf-student-ana", "student", "Ana Lima", "nf-s-2021"),
    // Grade 10.
    person(D, IDP, "prn_nf-student-lucia", "student", "Lucía Delgado", "nf-s-2022"),
    // Guardians, each with a child in two schools.
    person(D, IDP, "prn_nf-guardian-rosa", "guardian", "Rosa Delgado", "nf-g-3101", "rosa.delgado@family.example"),
    person(D, IDP, "prn_nf-guardian-kwame", "guardian", "Kwame Mensah", "nf-g-3102", "kwame.mensah@family.example"),
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
    enroll(D, "enr_nf-18", "off_nf-math7-fall-p1", "prn_nf-student-ana", "student"),
    enroll(D, "enr_nf-19", "off_nf-bio-fall-p2", "prn_nf-student-lucia", "student"),
    enroll(D, "enr_nf-20", "off_nf-eng8-fall-p2", "prn_nf-teacher-kowalski", "teacher"),
    enroll(D, "enr_nf-21", "off_nf-eng8-fall-p2", "prn_nf-student-kofi", "student"),
    enroll(D, "enr_nf-22", "off_nf-eng8-fall-p2", "prn_nf-student-maya", "student"),
    enroll(D, "enr_nf-23", "off_nf-eng8-fall-p2", "prn_nf-student-ravi", "student"),
    enroll(D, "enr_nf-24", "off_nf-whist7-fall-p4", "prn_nf-teacher-ortega", "teacher"),
    enroll(D, "enr_nf-25", "off_nf-whist7-fall-p4", "prn_nf-student-chidi", "student"),
    enroll(D, "enr_nf-26", "off_nf-whist7-fall-p4", "prn_nf-student-felix", "student"),
    enroll(D, "enr_nf-27", "off_nf-whist7-fall-p4", "prn_nf-student-ana", "student"),
    enroll(D, "enr_nf-28", "off_nf-ksci-fall-r4", "prn_nf-teacher-marsh", "teacher"),
    enroll(D, "enr_nf-29", "off_nf-ksci-fall-r4", "prn_nf-student-sofia", "student"),
    enroll(D, "enr_nf-30", "off_nf-ksci-fall-r4", "prn_nf-student-noah", "student"),
    enroll(D, "enr_nf-31", "off_nf-ksci-fall-r4", "prn_nf-student-aiyana", "student"),
    enroll(D, "enr_nf-32", "off_nf-g1read-fall-r7", "prn_nf-teacher-yazzie", "teacher"),
    enroll(D, "enr_nf-33", "off_nf-g1read-fall-r7", "prn_nf-student-mateo", "student"),
    enroll(D, "enr_nf-34", "off_nf-g1read-fall-r7", "prn_nf-student-priya", "student"),
    enroll(D, "enr_nf-35", "off_nf-g1read-fall-r7", "prn_nf-student-jonah", "student"),
    enroll(D, "enr_nf-36", "off_nf-g1math-fall-r7", "prn_nf-teacher-yazzie", "teacher"),
    enroll(D, "enr_nf-37", "off_nf-g1math-fall-r7", "prn_nf-student-mateo", "student"),
    enroll(D, "enr_nf-38", "off_nf-g1math-fall-r7", "prn_nf-student-priya", "student"),
    enroll(D, "enr_nf-39", "off_nf-g1math-fall-r7", "prn_nf-student-jonah", "student"),
    enroll(D, "enr_nf-40", "off_nf-g4ela-fall-r12", "prn_nf-teacher-alsayed", "teacher"),
    enroll(D, "enr_nf-41", "off_nf-g4ela-fall-r12", "prn_nf-student-abena", "student"),
    enroll(D, "enr_nf-42", "off_nf-g4ela-fall-r12", "prn_nf-student-diego", "student"),
    enroll(D, "enr_nf-43", "off_nf-g4ela-fall-r12", "prn_nf-student-hana", "student"),
    enroll(D, "enr_nf-44", "off_nf-g4math-fall-r12", "prn_nf-teacher-alsayed", "teacher"),
    enroll(D, "enr_nf-45", "off_nf-g4math-fall-r12", "prn_nf-student-abena", "student"),
    enroll(D, "enr_nf-46", "off_nf-g4math-fall-r12", "prn_nf-student-diego", "student"),
    enroll(D, "enr_nf-47", "off_nf-g4math-fall-r12", "prn_nf-student-hana", "student"),
    enroll(D, "enr_nf-48", "off_nf-g5sci-fall-lab", "prn_nf-teacher-johnson", "teacher"),
    enroll(D, "enr_nf-49", "off_nf-g5sci-fall-lab", "prn_nf-student-omar", "student"),
    enroll(D, "enr_nf-50", "off_nf-g5sci-fall-lab", "prn_nf-student-talia", "student"),
    enroll(D, "enr_nf-51", "off_nf-g5sci-fall-lab", "prn_nf-student-elijah", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_nf-district-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    { principalId: "prn_nf-principal-high", role: "school-admin", scope: { level: "school", districtId: D, schoolId: "sch_nf-high" }, source: "roster" },
    { principalId: "prn_nf-morgan-lee", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" }, source: "roster" },
    { principalId: "prn_nf-teacher-rivera", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" }, source: "roster" },
    { principalId: "prn_nf-teacher-chen", role: "co-teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" }, source: "roster" },
    { principalId: "prn_nf-teacher-chen", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-ushist-fall-p5" }, source: "roster" },
    { principalId: "prn_nf-teacher-patel", role: "teacher", scope: { level: "offering", districtId: D, schoolId: "sch_nf-middle", offeringId: "off_nf-math7-fall-p1" }, source: "roster" },
    teaches(D, "prn_nf-teacher-kowalski", "teacher", "sch_nf-middle", "off_nf-eng8-fall-p2"),
    teaches(D, "prn_nf-teacher-ortega", "teacher", "sch_nf-middle", "off_nf-whist7-fall-p4"),
    teaches(D, "prn_nf-teacher-marsh", "teacher", "sch_nf-elem", "off_nf-ksci-fall-r4"),
    teaches(D, "prn_nf-teacher-yazzie", "teacher", "sch_nf-elem", "off_nf-g1read-fall-r7"),
    teaches(D, "prn_nf-teacher-yazzie", "teacher", "sch_nf-elem", "off_nf-g1math-fall-r7"),
    teaches(D, "prn_nf-teacher-alsayed", "teacher", "sch_nf-elem", "off_nf-g4ela-fall-r12"),
    teaches(D, "prn_nf-teacher-alsayed", "teacher", "sch_nf-elem", "off_nf-g4math-fall-r12"),
    teaches(D, "prn_nf-teacher-johnson", "teacher", "sch_nf-elem", "off_nf-g5sci-fall-lab"),
  ],
});

/**
 * Northfield's guardian relationships, confirmed by the district administrator: Rosa Delgado for
 * Mateo (grade 1) and Lucía (grade 10), and Kwame Mensah for Abena (grade 4) and Kofi (grade 8).
 */
export const NORTHFIELD_GUARDIANS: readonly GuardianRelationship[] = [
  guardianOf(D, "grl_nf-rosa-mateo", "prn_nf-guardian-rosa", "prn_nf-student-mateo", "prn_nf-district-admin"),
  guardianOf(D, "grl_nf-rosa-lucia", "prn_nf-guardian-rosa", "prn_nf-student-lucia", "prn_nf-district-admin"),
  guardianOf(D, "grl_nf-kwame-abena", "prn_nf-guardian-kwame", "prn_nf-student-abena", "prn_nf-district-admin"),
  guardianOf(D, "grl_nf-kwame-kofi", "prn_nf-guardian-kwame", "prn_nf-student-kofi", "prn_nf-district-admin"),
].map((r) => GuardianRelationship.parse(r));
