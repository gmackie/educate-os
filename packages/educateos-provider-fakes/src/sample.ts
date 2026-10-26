// A small synthetic district every fake's contract tests share, and a worked example of a seed.
// No real people: names are invented and every address is on `maplewood.example`.
import type { DistrictSeed, PersonSeed, SectionSeed } from "./types.ts";

const DOMAIN = "maplewood.example";

function person(id: string, role: PersonSeed["role"], givenName: string, familyName: string, extra: Partial<PersonSeed> = {}): PersonSeed {
  return {
    id,
    role,
    givenName,
    familyName,
    email: `${givenName}.${familyName}@${DOMAIN}`.toLowerCase(),
    schoolIds: role === "guardian" ? [] : ["mw-hs"],
    ...extra,
  };
}

const STUDENTS: PersonSeed[] = [
  ["mw-s-01", "Ada", "Brightwater"],
  ["mw-s-02", "Bo", "Calder"],
  ["mw-s-03", "Cleo", "Dunmore"],
  ["mw-s-04", "Dev", "Ellery"],
  ["mw-s-05", "Esme", "Fairhall"],
  ["mw-s-06", "Finn", "Garrow"],
  ["mw-s-07", "Gia", "Holloway"],
  ["mw-s-08", "Hal", "Ingram"],
  ["mw-s-09", "Iris", "Jessop"],
  ["mw-s-10", "Jun", "Kestrel"],
].map(([id, given, family], i) => person(id!, "student", given!, family!, { grade: i < 5 ? "09" : "10", localId: `S${1001 + i}` }));

function section(id: string, title: string, courseId: string, teacherIds: string[], studentIds: string[], period: string): SectionSeed {
  return { id, title, courseId, schoolId: "mw-hs", termIds: ["mw-fall"], period, room: `R${period}0${period}`, teacherIds, studentIds };
}

/** Maplewood: one high school, a fall semester, three courses in four sections, and ten students. */
export const SAMPLE_DISTRICT: DistrictSeed = {
  id: "maplewood",
  name: "Maplewood Unified (synthetic)",
  domain: DOMAIN,
  modified: "2026-10-01T12:00:00.000Z",
  schools: [
    { id: "mw-hs", name: "Maplewood High School", schoolNumber: "301", lowGrade: "09", highGrade: "12" },
    { id: "mw-ms", name: "Maplewood Middle School", schoolNumber: "201", lowGrade: "06", highGrade: "08" },
  ],
  terms: [
    { id: "mw-2027", name: "2026-2027", type: "schoolYear", startDate: "2026-08-17", endDate: "2027-06-11", schoolYear: "2027" },
    { id: "mw-fall", name: "Fall 2026", type: "semester", startDate: "2026-08-17", endDate: "2026-12-18", parentId: "mw-2027", schoolYear: "2027" },
  ],
  courses: [
    { id: "mw-bio", title: "Biology", schoolId: "mw-hs", courseCode: "SCI-110", subject: "Science", grades: ["09", "10"] },
    { id: "mw-eng9", title: "English 9", schoolId: "mw-hs", courseCode: "ENG-109", subject: "English", grades: ["09"] },
    { id: "mw-alg", title: "Algebra I", schoolId: "mw-hs", courseCode: "MTH-101", subject: "Mathematics", grades: ["09", "10"] },
  ],
  sections: [
    section("mw-bio-p2", "Biology, period 2", "mw-bio", ["mw-t-okafor"], ["mw-s-01", "mw-s-02", "mw-s-03", "mw-s-04", "mw-s-05", "mw-s-06"], "2"),
    section("mw-bio-p4", "Biology, period 4", "mw-bio", ["mw-t-okafor"], ["mw-s-07", "mw-s-08", "mw-s-09", "mw-s-10"], "4"),
    section("mw-eng9-p1", "English 9, period 1", "mw-eng9", ["mw-t-quill", "mw-t-reyes"], ["mw-s-01", "mw-s-02", "mw-s-03", "mw-s-04", "mw-s-05"], "1"),
    section("mw-alg-p3", "Algebra I, period 3", "mw-alg", ["mw-t-reyes"], ["mw-s-06", "mw-s-07", "mw-s-08", "mw-s-09", "mw-s-10"], "3"),
  ],
  people: [
    ...STUDENTS,
    person("mw-t-okafor", "teacher", "Nia", "Okafor", { localId: "T201" }),
    person("mw-t-quill", "teacher", "Theo", "Quill", { localId: "T202" }),
    person("mw-t-reyes", "teacher", "Marisol", "Reyes", { localId: "T203", schoolIds: ["mw-hs", "mw-ms"] }),
    person("mw-staff-lund", "staff", "Pell", "Lund", { localId: "E301" }),
    person("mw-admin-varga", "administrator", "Ilse", "Varga", { localId: "A401", schoolIds: ["mw-hs", "mw-ms"] }),
    person("mw-g-brightwater", "guardian", "Rowan", "Brightwater", { guardianOf: ["mw-s-01"], relationship: "parent" }),
    person("mw-g-garrow", "guardian", "Sage", "Garrow", { guardianOf: ["mw-s-06"], relationship: "guardian" }),
  ],
  assignments: [
    {
      id: "mw-bio-p2-lab",
      sectionId: "mw-bio-p2",
      title: "Cell lab report",
      maxPoints: 100,
      dueAt: "2026-10-30T23:59:00.000Z",
      createdByIntegration: true,
      submissions: [
        { studentId: "mw-s-01", state: "TURNED_IN", draftGrade: 88 },
        { studentId: "mw-s-02", state: "TURNED_IN" },
        { studentId: "mw-s-03", state: "CREATED" },
      ],
    },
    { id: "mw-bio-p2-quiz", sectionId: "mw-bio-p2", title: "Teacher-made quiz", maxPoints: 20, submissions: [{ studentId: "mw-s-01", state: "RETURNED", assignedGrade: 18 }] },
  ],
};
