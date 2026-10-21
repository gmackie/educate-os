// Generates the synthetic Northfield OneRoster 1.2 bulk export and its mutation variants. The CSV
// files beside this module are its output: regenerate them with `pnpm fixtures:write` after editing
// it, and `fixtures.test.ts` fails if they drift. Every person here is invented, and every domain is
// a reserved `.example` one.
//
// The district mirrors `NORTHFIELD` in @schoolos/fixtures: the same schools, terms, courses, classes,
// people and IdP subjects, so an import can be checked against the hand-written snapshot.

/** The mutation variants, each a complete export. */
export const VARIANTS = [
  /** The district as it stands. */
  "northfield",
  /** Felix Brandt has left: his user, role and enrollment rows are gone. */
  "dropped-student",
  /** Amara Okafor's username, the IdP subject, has changed. */
  "changed-username",
  /** Elena Sato has been given Dmitri Novak's username. */
  "duplicate-username",
  /** One enrollment row has a role OneRoster does not define. */
  "malformed-row",
] as const;

/** A mutation variant. */
export type Variant = (typeof VARIANTS)[number];

/** A synthetic value that appears only in demographics.csv, which SchoolOS must never read. */
export const DEMOGRAPHICS_SENTINEL = "SENTINEL-DEMOGRAPHIC-7f3a";
/** A synthetic password that appears only in users.csv's password column, which must never be kept. */
export const PASSWORD_SENTINEL = "SENTINEL-PASSWORD-91c2";

const HEADERS = {
  "orgs.csv": "sourcedId,status,dateLastModified,name,type,identifier,parentSourcedId",
  "academicSessions.csv": "sourcedId,status,dateLastModified,title,type,startDate,endDate,parentSourcedId,schoolYear",
  "courses.csv": "sourcedId,status,dateLastModified,schoolYearSourcedId,title,courseCode,grades,orgSourcedId,subjects,subjectCodes",
  "classes.csv": "sourcedId,status,dateLastModified,title,grades,courseSourcedId,classCode,classType,location,schoolSourcedId,termSourcedIds,subjects,subjectCodes,periods",
  "users.csv": "sourcedId,status,dateLastModified,enabledUser,username,userIds,givenName,familyName,middleName,identifier,email,sms,phone,agentSourcedIds,grades,password,userMasterIdentifier,resourceSourcedIds,preferredGivenName,preferredMiddleName,preferredFamilyName,primaryOrgSourcedId,pronouns",
  "roles.csv": "sourcedId,status,dateLastModified,userSourcedId,roleType,role,beginDate,endDate,orgSourcedId,userProfileSourcedId",
  "enrollments.csv": "sourcedId,status,dateLastModified,classSourcedId,schoolSourcedId,userSourcedId,role,primary,beginDate,endDate",
} as const;

interface Person {
  sourcedId: string;
  username: string;
  sis: string;
  givenName: string;
  familyName: string;
  email: string;
  role: "student" | "teacher" | "principal" | "districtAdministrator" | "guardian";
  org: string;
  grades: string;
  agents?: string;
}

const PEOPLE: Person[] = [
  { sourcedId: "u-avery", username: "nf-0001", sis: "1001", givenName: "Avery", familyName: "Admin", email: "avery.admin@northfield.example", role: "districtAdministrator", org: "org-nf-district", grades: "" },
  { sourcedId: "u-jordan", username: "nf-0002", sis: "1002", givenName: "Jordan", familyName: "Principal", email: "jordan.principal@northfield.example", role: "principal", org: "org-nf-high", grades: "" },
  { sourcedId: "u-morgan", username: "user-1042", sis: "1042", givenName: "Morgan", familyName: "Lee", email: "morgan.lee@teachers.example", role: "teacher", org: "org-nf-high", grades: "" },
  { sourcedId: "u-rivera", username: "nf-0101", sis: "1101", givenName: "Sam", familyName: "Rivera", email: "sam.rivera@northfield.example", role: "teacher", org: "org-nf-high", grades: "" },
  { sourcedId: "u-chen", username: "nf-0102", sis: "1102", givenName: "Riley", familyName: "Chen", email: "riley.chen@northfield.example", role: "teacher", org: "org-nf-high", grades: "" },
  { sourcedId: "u-patel", username: "nf-0103", sis: "1103", givenName: "Casey", familyName: "Patel", email: "casey.patel@northfield.example", role: "teacher", org: "org-nf-middle", grades: "" },
  { sourcedId: "u-amara", username: "nf-s-2001", sis: "2001", givenName: "Amara", familyName: "Okafor", email: "family.okafor@northfield.example", role: "student", org: "org-nf-high", grades: "09", agents: "u-guardian-okafor" },
  { sourcedId: "u-chidi", username: "nf-s-2002", sis: "2002", givenName: "Chidi", familyName: "Okafor", email: "family.okafor@northfield.example", role: "student", org: "org-nf-middle", grades: "07", agents: "u-guardian-okafor" },
  { sourcedId: "u-dmitri", username: "nf-s-2003", sis: "2003", givenName: "Dmitri", familyName: "Novak", email: "", role: "student", org: "org-nf-high", grades: "09" },
  { sourcedId: "u-elena", username: "nf-s-2004", sis: "2004", givenName: "Elena", familyName: "Sato", email: "", role: "student", org: "org-nf-high", grades: "09" },
  { sourcedId: "u-felix", username: "nf-s-2005", sis: "2005", givenName: "Felix", familyName: "Brandt", email: "", role: "student", org: "org-nf-middle", grades: "07" },
  // A guardian: listed in OneRoster exports, never imported by SchoolOS v1.
  { sourcedId: "u-guardian-okafor", username: "nf-g-3001", sis: "3001", givenName: "Ngozi", familyName: "Okafor", email: "family.okafor@northfield.example", role: "guardian", org: "org-nf-district", grades: "" },
];

// [sourcedId, class, user, role, primary, status]
const ENROLLMENTS: [string, string, string, "student" | "teacher", "" | "true" | "false", "" | "tobedeleted"][] = [
  ["e-01", "cls-bio-fall-p2", "u-morgan", "teacher", "true", ""],
  ["e-02", "cls-bio-fall-p2", "u-amara", "student", "", ""],
  ["e-03", "cls-bio-fall-p2", "u-dmitri", "student", "", ""],
  ["e-04", "cls-bio-fall-p2", "u-elena", "student", "", ""],
  ["e-05", "cls-bio-spring-p4", "u-morgan", "teacher", "true", ""],
  ["e-06", "cls-bio-spring-p4", "u-amara", "student", "", ""],
  ["e-07", "cls-eng9-fall-p3", "u-rivera", "teacher", "true", ""],
  ["e-08", "cls-eng9-fall-p3", "u-chen", "teacher", "false", ""],
  ["e-09", "cls-eng9-fall-p3", "u-amara", "student", "", ""],
  ["e-10", "cls-eng9-fall-p3", "u-dmitri", "student", "", "tobedeleted"],
  ["e-11", "cls-eng9-fall-p3", "u-elena", "student", "", ""],
  ["e-12", "cls-ushist-fall-p5", "u-chen", "teacher", "true", ""],
  ["e-13", "cls-ushist-fall-p5", "u-elena", "student", "", ""],
  ["e-14", "cls-ushist-fall-p5", "u-dmitri", "student", "", ""],
  ["e-15", "cls-math7-fall-p1", "u-patel", "teacher", "true", ""],
  ["e-16", "cls-math7-fall-p1", "u-chidi", "student", "", ""],
  ["e-17", "cls-math7-fall-p1", "u-felix", "student", "", ""],
];

const CLASS_SCHOOL: Record<string, string> = {
  "cls-bio-fall-p2": "org-nf-high",
  "cls-bio-spring-p4": "org-nf-high",
  "cls-eng9-fall-p3": "org-nf-high",
  "cls-ushist-fall-p5": "org-nf-high",
  "cls-math7-fall-p1": "org-nf-middle",
};

/** Quotes a field when RFC 4180 requires it. */
function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csv(header: string, rows: string[][]): string {
  return [header, ...rows.map((row) => row.map(field).join(","))].join("\r\n") + "\r\n";
}

/** Builds one variant's export: file contents keyed by file name. */
export function buildExport(variant: Variant): Record<string, string> {
  const people = PEOPLE
    .filter((p) => !(variant === "dropped-student" && p.sourcedId === "u-felix"))
    .map((p) => {
      if (variant === "changed-username" && p.sourcedId === "u-amara") return { ...p, username: "nf-s-2001-renamed" };
      if (variant === "duplicate-username" && p.sourcedId === "u-elena") return { ...p, username: "nf-s-2003" };
      return p;
    });
  const enrollments = ENROLLMENTS.filter(([, , user]) => people.some((p) => p.sourcedId === user));

  const manifest = csv("propertyName,value", [
    ["manifest.version", "1.0"],
    ["oneroster.version", "1.2"],
    ["file.academicSessions", "bulk"],
    ["file.categories", "absent"],
    ["file.classes", "bulk"],
    ["file.classResources", "absent"],
    ["file.courses", "bulk"],
    ["file.courseResources", "absent"],
    ["file.demographics", "bulk"],
    ["file.enrollments", "bulk"],
    ["file.lineItems", "absent"],
    ["file.orgs", "bulk"],
    ["file.resources", "absent"],
    ["file.results", "absent"],
    ["file.roles", "bulk"],
    ["file.userProfiles", "absent"],
    ["file.users", "bulk"],
    ["source.systemName", "Synthetic SIS"],
    ["source.systemCode", "synthetic-sis"],
  ]);

  return {
    "manifest.csv": manifest,
    // Spreadsheet exports often begin with a byte order mark; the reader must skip it.
    "orgs.csv": "﻿" + csv(HEADERS["orgs.csv"], [
      ["org-nf-district", "", "", "Northfield Public Schools (synthetic)", "district", "NF", ""],
      ["org-nf-high", "", "", "Northfield High School", "school", "NF-HS", "org-nf-district"],
      ["org-nf-middle", "", "", "Northfield Middle School", "school", "NF-MS", "org-nf-district"],
    ]),
    "academicSessions.csv": csv(HEADERS["academicSessions.csv"], [
      ["sy-2025-26", "", "", "2025-2026", "schoolYear", "2025-08-01", "2026-07-31", "", "2026"],
      ["sem-2026-spring", "", "", "Spring 2026", "semester", "2026-01-12", "2026-06-12", "sy-2025-26", "2026"],
      ["sy-2026-27", "", "", "2026-2027", "schoolYear", "2026-08-01", "2027-07-31", "", "2027"],
      ["sem-2026-fall", "", "", "Fall 2026", "semester", "2026-08-31", "2027-01-22", "sy-2026-27", "2027"],
      ["gp-2026-fall-q1", "", "", "Fall 2026, Quarter 1", "gradingPeriod", "2026-08-31", "2026-10-30", "sem-2026-fall", "2027"],
    ]),
    "courses.csv": csv(HEADERS["courses.csv"], [
      ["crs-biology-1", "", "", "", "Biology I", "BIO1", "09,10", "org-nf-district", "Biology", "03051"],
      ["crs-english-9", "", "", "", "English 9", "ENG9", "09", "org-nf-district", "English Language Arts", ""],
      // No free-text subject: the SCED code (04 = social sciences and history) decides.
      ["crs-us-history", "", "", "", "United States History", "USH", "11", "org-nf-district", "", "04104"],
      ["crs-math-7", "", "", "", "Mathematics 7", "MA7", "07", "org-nf-district", "Math", ""],
      // Neither subject is in the table, so it falls back to `other`.
      ["crs-advisory-9", "", "", "", "Advisory, Grade 9", "ADV9", "09", "org-nf-district", "Advisory", "22001"],
    ]),
    "classes.csv": csv(HEADERS["classes.csv"], [
      ["cls-bio-fall-p2", "", "", "Period 2", "09,10", "crs-biology-1", "BIO1-2", "scheduled", "Room 114", "org-nf-high", "sem-2026-fall", "", "", "2"],
      ["cls-bio-spring-p4", "", "", "Period 4", "09,10", "crs-biology-1", "BIO1-4", "scheduled", "Room 114", "org-nf-high", "sem-2026-spring", "", "", "4"],
      // Names a grading period: its term is the semester above it.
      ["cls-eng9-fall-p3", "", "", "Period 3", "09", "crs-english-9", "ENG9-3", "scheduled", "Room 201", "org-nf-high", "gp-2026-fall-q1", "", "", "3"],
      // Also names its school year, which is not a SchoolOS term.
      ["cls-ushist-fall-p5", "", "", "Period 5", "11", "crs-us-history", "USH-5", "scheduled", "Room 305", "org-nf-high", "sy-2026-27,sem-2026-fall", "", "", "5"],
      ["cls-math7-fall-p1", "", "", "Period 1", "07", "crs-math-7", "MA7-1", "scheduled", "Room 12", "org-nf-middle", "sem-2026-fall", "", "", "1"],
    ]),
    "users.csv": csv(HEADERS["users.csv"], people.map((p) => [
      p.sourcedId, "", "", "true", p.username, `{idp:${p.username}},{sis:${p.sis}}`, p.givenName, p.familyName, "", p.sis,
      p.email, "", "", p.agents ?? "", p.grades, PASSWORD_SENTINEL, "", "", "", "", "", p.org, "",
    ])),
    "roles.csv": csv(HEADERS["roles.csv"], people.map((p) => [
      `r-${p.sourcedId}`, "", "", p.sourcedId, "primary", p.role, "", "", p.org, "",
    ])),
    "enrollments.csv": csv(HEADERS["enrollments.csv"], enrollments.map(([id, cls, user, role, primary, status], i) => [
      id, status, "", cls, CLASS_SCHOOL[cls]!, user,
      variant === "malformed-row" && i === 4 ? "pupil" : role,
      primary, "", "",
    ])),
    // Never read. The quoting is broken on purpose, so reading it at all would fail the import.
    "demographics.csv": `sourcedId,status,dateLastModified,birthDate,sex\r\nu-amara,,,2011-04-02,"${DEMOGRAPHICS_SENTINEL}\r\n`,
  };
}
