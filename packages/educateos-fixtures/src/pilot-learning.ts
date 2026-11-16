// A small, invented district for the student-led learning pilot (SCHO-432). Every person, school and
// answer here is synthetic: nothing is a real child, family, class or response, and the "student
// work" is scripted so the harness can replay the same journeys on every run.
import { DistrictDirectorySnapshot } from "@educateos/contracts";
import { enroll, person, teaches } from "./builders.ts";

const D = "dst_pilot-lakes";
const IDP = "https://idp.pilot-lakes.example";

/**
 * Pilot Lakes (synthetic): a grade 6 and a grade 7 project-math class in one middle school, and a
 * grade 5 science class in an elementary school (a band that must never reach a model).
 *
 * Deliberate edge cases:
 * - `prn_pl-student-ines` is enrolled only in the grade 5 class, so she is a student of the district
 *   who must see nothing of the grade 6 class.
 * - `prn_pl-student-noor` has an interest that has no natural fit with any approved standard.
 * - `prn_pl-student-quinn` was dropped from the grade 6 class: the enrollment is inactive.
 */
export const PILOT_LEARNING = DistrictDirectorySnapshot.parse({
  district: { id: D, name: "Pilot Lakes Schools (synthetic)", timeZone: "America/Chicago", trustedIssuers: [IDP] },
  schools: [
    { id: "sch_pl-middle", districtId: D, name: "Pilot Lakes Middle School", gradeBands: ["6-8"] },
    { id: "sch_pl-elem", districtId: D, name: "Pilot Lakes Elementary School", gradeBands: ["K-5"] },
  ],
  terms: [{ id: "trm_pl-2026-fall", districtId: D, name: "Fall 2026", startsOn: "2026-08-31", endsOn: "2027-01-22", state: "active" }],
  courses: [
    { id: "crs_pl-project-math-6", districtId: D, title: "Project Math 6", subject: "mathematics", gradeBand: "6" },
    { id: "crs_pl-project-math-7", districtId: D, title: "Project Math 7", subject: "mathematics", gradeBand: "7" },
    { id: "crs_pl-science-5", districtId: D, title: "Grade 5 Science Studio", subject: "science", gradeBand: "5" },
  ],
  offerings: [
    { id: "off_pl-pm6", districtId: D, schoolId: "sch_pl-middle", termId: "trm_pl-2026-fall", courseId: "crs_pl-project-math-6", sectionName: "Period 2" },
    { id: "off_pl-pm7", districtId: D, schoolId: "sch_pl-middle", termId: "trm_pl-2026-fall", courseId: "crs_pl-project-math-7", sectionName: "Period 4" },
    { id: "off_pl-sci5", districtId: D, schoolId: "sch_pl-elem", termId: "trm_pl-2026-fall", courseId: "crs_pl-science-5", sectionName: "Studio" },
  ],
  principals: [
    person(D, IDP, "prn_pl-admin", "staff", "Pat Admin", "pl-0001", "pat.admin@pilot-lakes.example"),
    person(D, IDP, "prn_pl-teacher-okoye", "staff", "Ada Okoye", "pl-0101", "ada.okoye@pilot-lakes.example"),
    person(D, IDP, "prn_pl-teacher-vance", "staff", "Ben Vance", "pl-0102", "ben.vance@pilot-lakes.example"),
    person(D, IDP, "prn_pl-student-jules", "student", "Jules Park", "pl-s-1001"),
    person(D, IDP, "prn_pl-student-maribel", "student", "Maribel Ortiz", "pl-s-1002"),
    person(D, IDP, "prn_pl-student-darnell", "student", "Darnell Wright", "pl-s-1003"),
    person(D, IDP, "prn_pl-student-noor", "student", "Noor Haddad", "pl-s-1004"),
    person(D, IDP, "prn_pl-student-quinn", "student", "Quinn Abara", "pl-s-1005"),
    person(D, IDP, "prn_pl-student-tariq", "student", "Tariq Ellis", "pl-s-1006"),
    person(D, IDP, "prn_pl-student-lena", "student", "Lena Fox", "pl-s-1007"),
    person(D, IDP, "prn_pl-student-ines", "student", "Ines Calder", "pl-s-1008"),
  ],
  enrollments: [
    enroll(D, "enr_pl-01", "off_pl-pm6", "prn_pl-teacher-okoye", "teacher"),
    enroll(D, "enr_pl-02", "off_pl-pm6", "prn_pl-student-jules", "student"),
    enroll(D, "enr_pl-03", "off_pl-pm6", "prn_pl-student-maribel", "student"),
    enroll(D, "enr_pl-04", "off_pl-pm6", "prn_pl-student-darnell", "student"),
    enroll(D, "enr_pl-05", "off_pl-pm6", "prn_pl-student-noor", "student"),
    enroll(D, "enr_pl-06", "off_pl-pm6", "prn_pl-student-quinn", "student", "inactive"),
    enroll(D, "enr_pl-07", "off_pl-pm7", "prn_pl-teacher-okoye", "teacher"),
    enroll(D, "enr_pl-08", "off_pl-pm7", "prn_pl-student-tariq", "student"),
    enroll(D, "enr_pl-09", "off_pl-sci5", "prn_pl-teacher-vance", "teacher"),
    enroll(D, "enr_pl-10", "off_pl-sci5", "prn_pl-student-lena", "student"),
    enroll(D, "enr_pl-11", "off_pl-sci5", "prn_pl-student-ines", "student"),
  ],
  roleAssignments: [
    { principalId: "prn_pl-admin", role: "district-admin", scope: { level: "district", districtId: D }, source: "local-grant" },
    teaches(D, "prn_pl-teacher-okoye", "teacher", "sch_pl-middle", "off_pl-pm6"),
    teaches(D, "prn_pl-teacher-okoye", "teacher", "sch_pl-middle", "off_pl-pm7"),
    teaches(D, "prn_pl-teacher-vance", "teacher", "sch_pl-elem", "off_pl-sci5"),
  ],
});

/** The pilot district's people and classes, by role. */
export const PL = {
  admin: "prn_pl-admin",
  okoye: "prn_pl-teacher-okoye",
  vance: "prn_pl-teacher-vance",
  jules: "prn_pl-student-jules",
  maribel: "prn_pl-student-maribel",
  darnell: "prn_pl-student-darnell",
  noor: "prn_pl-student-noor",
  quinn: "prn_pl-student-quinn",
  tariq: "prn_pl-student-tariq",
  lena: "prn_pl-student-lena",
  ines: "prn_pl-student-ines",
  grade6: "off_pl-pm6",
  grade7: "off_pl-pm7",
  grade5: "off_pl-sci5",
} as const satisfies Record<string, string>;

/** The standards the pilot may offer, as the learner and teacher see them. */
export type PilotStandardCode = "6.RP.A.3b" | "W.6.1" | "7.RP.A.1" | "W.7.1";

/** What a persona does with one opportunity. Scripted, never generated. */
export interface PilotWork {
  /** The standard this opportunity is expected to carry. */
  code: PilotStandardCode;
  /** `skip` is a real, honored choice: nothing is shared and nothing is inferred. */
  action: "skip" | "practice";
  /** The project response the student shares, and how much help they disclose on it. */
  project?: { text: string; assistance: "independent" | "adult" | "peer" | "ai" | "unknown" };
  /** The separate practice challenge, with the learner's own help disclosure. */
  challenge?: { text: string; reflection: string; assistance: "independent" | "adult" | "peer" | "ai" | "unknown" };
}

/** One synthetic learner, the interest they bring and how their journey is scripted to end. */
export interface PilotPersona {
  /** Stable key for goldens. */
  key: "roblox-pizza" | "cookie-business" | "basketball" | "no-alignment" | "grade-seven-basketball" | "grade-five";
  principalId: string;
  offeringId: string;
  /** What the student types, verbatim. */
  interest: string;
  /** Standards the registry-pinned mapping should offer for this interest; empty means no lesson. */
  expectedCodes: PilotStandardCode[];
  /** What the student does with each offered standard. */
  work: PilotWork[];
}

/**
 * Three varied motivations, one negative example and two band checks. The numbers are curated
 * instructional prompts, not claims about real game or sports statistics.
 */
export const PILOT_PERSONAS: readonly PilotPersona[] = [
  {
    key: "roblox-pizza",
    principalId: PL.jules,
    offeringId: PL.grade6,
    interest: "Build a Roblox Pizza Tycoon",
    expectedCodes: ["6.RP.A.3b", "W.6.1"],
    work: [
      {
        code: "6.RP.A.3b",
        action: "practice",
        // The project help is disclosed as AI: a finished tycoon explanation must not count as mastery.
        project: { text: "Oven A: 12 ÷ 3 = 4 pizzas per minute. Oven B: 15 ÷ 5 = 3 pizzas per minute. After 20 minutes: 80 and 60. I choose oven A because orders arrive fast; this assumes the rate stays constant.", assistance: "ai" },
        challenge: { text: "Printer one makes 6 cards per minute and printer two makes 5. In 7 minutes: 42 and 35 cards, if the rates stay constant.", reflection: "I could use this for how fast my customers walk to the counter.", assistance: "independent" },
      },
      { code: "W.6.1", action: "skip" },
    ],
  },
  {
    key: "cookie-business",
    principalId: PL.maribel,
    offeringId: PL.grade6,
    interest: "Compare cookie prices and persuade our club to choose a recipe",
    expectedCodes: ["6.RP.A.3b", "W.6.1"],
    work: [
      {
        code: "6.RP.A.3b",
        action: "practice",
        project: { text: "12 cookies for $6 is $0.50 each; 20 for $8 is $0.40 each. 30 cookies would cost $15 or $12. The 20-pack is cheaper per cookie, assuming the price per cookie stays the same.", assistance: "adult" },
        challenge: { text: "A baker sells 18 muffins for $9 and 24 for $10.80. That is $0.50 and $0.45 each, so the larger box costs less per muffin.", reflection: "Unit price also helps me compare phone plans.", assistance: "independent" },
      },
      {
        code: "W.6.1",
        action: "practice",
        project: { text: "Our club should choose the 20-pack recipe because it costs less per cookie. The price list shows $0.40 versus $0.50. However, the larger pack needs more storage, so we should check the cupboard.", assistance: "peer" },
        // Practised with a peer: the teacher can record it, but cannot recommend mastery from it.
        challenge: { text: "School lunch should include a fruit choice because students can pick what they will actually eat. Therefore waste would go down.", reflection: "I would write about a different decision next time.", assistance: "peer" },
      },
    ],
  },
  {
    key: "basketball",
    principalId: PL.darnell,
    offeringId: PL.grade6,
    interest: "Track my basketball practice: free throws made per minute",
    expectedCodes: ["6.RP.A.3b"],
    work: [
      {
        code: "6.RP.A.3b",
        action: "practice",
        project: { text: "Drill A: 18 ÷ 6 = 3 free throws per minute. Drill B: 14 ÷ 4 = 3.5 per minute. In 20 minutes: 60 and 70. Drill B fits a goal of more makes per minute, if I do not get tired.", assistance: "independent" },
        // An AI-assisted challenge is disclosed honestly and so cannot become independent evidence.
        challenge: { text: "Printer one makes 6 cards per minute and printer two makes 5. In 7 minutes: 42 and 35.", reflection: "A chatbot walked me through it.", assistance: "ai" },
      },
    ],
  },
  {
    key: "no-alignment",
    principalId: PL.noor,
    offeringId: PL.grade6,
    interest: "I want to learn about black holes and write a poem about astronomy",
    expectedCodes: [],
    work: [],
  },
  {
    key: "grade-seven-basketball",
    principalId: PL.tariq,
    offeringId: PL.grade7,
    interest: "Track my basketball practice: free throws made per minute",
    expectedCodes: ["7.RP.A.1"],
    work: [
      {
        code: "7.RP.A.1",
        action: "practice",
        project: { text: "I made 3/4 of a bucket-set in 1/2 minute. 3/4 ÷ 1/2 = 3/2 sets per minute, so 3 sets in 2 minutes.", assistance: "independent" },
        challenge: { text: "A cyclist rides 3/4 mile in 1/8 hour: 6 miles per hour. In 1/2 hour that is 3 miles.", reflection: "Fraction rates also work for recipes.", assistance: "independent" },
      },
    ],
  },
  {
    key: "grade-five",
    principalId: PL.lena,
    offeringId: PL.grade5,
    interest: "Build a Roblox Pizza Tycoon",
    expectedCodes: [],
    work: [],
  },
];
