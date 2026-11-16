// A synthetic teacher Guidance dashboard (Guidance and Evidence), for tests, Storybook-style demos
// and design review. Every person here is invented and obviously so ("Sample", "Demo", "Example");
// no real student, guardian or district appears. The shapes are structural copies of the district
// API's `teacher.guidance` and `teacher.guidanceEvidence` responses, declared here as plain data so
// this package needs no dependency on the district app; the teacher UI's tests parse them with the
// real schemas (`TeacherGuidanceBody`, `TeacherEvidenceBody`), so any drift fails there.

const FRAMEWORK = "ccss-ela";
const uri = (code: string) => `urn:educateos:catalog:${FRAMEWORK}:${code}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The invented class roster the sample describes. */
export const GUIDANCE_SAMPLE_STUDENTS = [
  { id: "prn_sample-avery", name: "Avery Example" },
  { id: "prn_sample-blake", name: "Blake Sample" },
  { id: "prn_sample-casey", name: "Casey Placeholder" },
  { id: "prn_sample-drew", name: "Drew Testfield" },
  { id: "prn_sample-emery", name: "Emery Demo" },
] as const;

const coverageBase = { frameworkKey: FRAMEWORK, roster: 5 } as const;

/**
 * Four standards, one per situation a teacher must be able to tell apart:
 * W.6.1: approved, a focus, with evidence at all four levels and a pathway;
 * W.6.2: approved, supporting, no evidence pathway yet (every student shows "needs evidence");
 * W.6.3: the district hid it, so it is not offered but a saved priority stays visible;
 * RI.6.9: saved earlier, no longer in any approved release (explicitly unmapped).
 */
export const GUIDANCE_DASHBOARD_SAMPLE = {
  agenda: {
    revision: 3,
    priorities: [
      { frameworkKey: FRAMEWORK, competencyUri: uri("W.6.1"), level: "focus", code: "W.6.1", statement: "Write arguments to support claims with clear reasons and relevant evidence.", pacing: { startsOn: "2026-11-16", endsOn: "2026-12-11" }, discussionPrompt: "Which claim in our class debate had the strongest evidence, and why?" },
      { frameworkKey: FRAMEWORK, competencyUri: uri("W.6.2"), level: "supporting", code: "W.6.2", statement: "Write informative/explanatory texts to examine a topic and convey ideas." },
      { frameworkKey: FRAMEWORK, competencyUri: uri("W.6.3"), level: "supporting", code: "W.6.3", statement: "Write narratives to develop real or imagined experiences." },
      { frameworkKey: FRAMEWORK, competencyUri: uri("RI.6.9"), level: "supporting", code: "RI.6.9", statement: "Compare and contrast one author's presentation of events with another's." },
    ],
  },
  coverage: [
    {
      ...coverageBase, competencyUri: uri("W.6.1"), code: "W.6.1", statement: "Write arguments to support claims with clear reasons and relevant evidence.", state: "approved",
      frameworkTitle: "Common Core State Standards for English Language Arts", publisher: "NGA Center and CCSSO", releaseVersion: "2026.1", provenance: "derived",
      priority: { level: "focus", pacing: { startsOn: "2026-11-16", endsOn: "2026-12-11" }, discussionPrompt: "Which claim in our class debate had the strongest evidence, and why?" },
      evidencePathway: "planner",
      mastery: { "needs-evidence": 1, "encountered": 1, "practiced": 1, "independent-reviewed": 2 },
      opportunities: { offered: 6, accepted: 4, skipped: 1, shared: 4, reviewed: 3 },
    },
    {
      ...coverageBase, competencyUri: uri("W.6.2"), code: "W.6.2", statement: "Write informative/explanatory texts to examine a topic and convey ideas.", state: "approved",
      frameworkTitle: "Common Core State Standards for English Language Arts", publisher: "NGA Center and CCSSO", releaseVersion: "2026.1", provenance: "derived",
      priority: { level: "supporting" }, evidencePathway: "none",
      mastery: { "needs-evidence": 5, "encountered": 0, "practiced": 0, "independent-reviewed": 0 },
      opportunities: { offered: 0, accepted: 0, skipped: 0, shared: 0, reviewed: 0 },
    },
    {
      ...coverageBase, competencyUri: uri("W.6.3"), code: "W.6.3", statement: "Write narratives to develop real or imagined experiences.", state: "hidden",
      priority: { level: "supporting" }, evidencePathway: "none",
      mastery: { "needs-evidence": 5, "encountered": 0, "practiced": 0, "independent-reviewed": 0 },
      opportunities: { offered: 0, accepted: 0, skipped: 0, shared: 0, reviewed: 0 },
    },
    {
      ...coverageBase, competencyUri: uri("RI.6.9"), code: "RI.6.9", statement: "Compare and contrast one author's presentation of events with another's.", state: "unmapped",
      priority: { level: "supporting" }, evidencePathway: "none",
      mastery: { "needs-evidence": 5, "encountered": 0, "practiced": 0, "independent-reviewed": 0 },
      opportunities: { offered: 0, accepted: 0, skipped: 0, shared: 0, reviewed: 0 },
    },
  ],
  suggestions: [
    {
      id: id(101), revision: 1, studentId: "prn_sample-drew", studentName: "Drew Testfield", guardianName: "Sample Guardian (for Drew)", kind: "hobby",
      topic: "Building model rockets", note: "Drew builds model rockets at home and may enjoy writing about how they work.",
      status: "awaiting-teacher", createdAt: "2026-11-12T15:00:00.000Z", expiresAt: "2026-12-12T15:00:00.000Z", studentAccepted: false,
    },
    {
      id: id(102), revision: 3, studentId: "prn_sample-blake", studentName: "Blake Sample", guardianName: "Example Guardian (for Blake)", kind: "curiosity",
      topic: "How do bridges stay up?", status: "shared", createdAt: "2026-11-05T15:00:00.000Z", expiresAt: "2027-02-03T15:00:00.000Z",
      review: { by: "prn_sample-teacher", byName: "Ms. Sample", at: "2026-11-06T15:00:00.000Z", decision: "share" }, studentAccepted: true,
    },
  ],
  practice: [
    { id: id(201), studentId: "prn_sample-avery", studentName: "Avery Example", skill: "teamwork", note: "For the group debate.", accepted: true, createdAt: "2026-11-10T15:00:00.000Z" },
    { id: id(202), studentId: "prn_sample-casey", studentName: "Casey Placeholder", skill: "planning", accepted: false, createdAt: "2026-11-10T15:00:00.000Z" },
  ],
  assignmentNote: "Everything on this page is a suggestion. To make something required, use Create activity.",
} as const;

const review = (n: number, level: string, assistance: string, decision: string, rationale: string) =>
  ({ level, assistance, independentlyAssessed: assistance === "independent" && decision === "recommend", decision, rationale, by: "prn_sample-teacher", at: `2026-11-1${n}T16:00:00.000Z` });

/** The drill-down for W.6.1 in the sample class. Only what students chose to share appears. */
export const GUIDANCE_EVIDENCE_SAMPLE = {
  row: GUIDANCE_DASHBOARD_SAMPLE.coverage[0],
  students: [
    {
      studentId: "prn_sample-avery", displayName: "Avery Example", state: "independent-reviewed",
      evidence: [{
        opportunityId: id(301), planId: id(401), source: "student", task: "Choose a decision in your project. Write a claim, support it with clear reasons and evidence, and defend it to your teacher.",
        criteria: ["State a claim and organize reasons and relevant evidence clearly", "Independently explain why the evidence supports the claim"], decision: "accepted",
        response: { text: "SAMPLE RESPONSE: Our class should vote on the field trip because two reasons from two sources agree.", assistance: "independent", sharedAt: "2026-11-09T14:00:00.000Z" },
        reviews: [review(0, "demonstrated", "independent", "recommend", "Defended the claim aloud with no help.")],
      }],
    },
    {
      studentId: "prn_sample-blake", displayName: "Blake Sample", state: "independent-reviewed",
      evidence: [{
        opportunityId: id(302), planId: id(402), source: "teacher", task: "Argue for one recipe for the club, using evidence from two credible sources.",
        criteria: ["State a claim and organize reasons and relevant evidence clearly"], decision: "accepted",
        response: { text: "SAMPLE RESPONSE: Recipe B costs less per cookie, and both sources say it keeps longer.", assistance: "independent", sharedAt: "2026-11-09T15:00:00.000Z" },
        reviews: [review(1, "practiced", "adult", "hold", "Needed a hint on sources."), review(2, "demonstrated", "independent", "recommend", "Fresh problem solved alone.")],
      }],
    },
    {
      studentId: "prn_sample-casey", displayName: "Casey Placeholder", state: "practiced",
      evidence: [{
        opportunityId: id(303), planId: id(403), source: "student", task: "Choose a decision in your project and write a claim with reasons.",
        criteria: ["State a claim and organize reasons and relevant evidence clearly"], decision: "accepted",
        response: { text: "SAMPLE RESPONSE: I think the club should meet on Fridays. (Used a helper for the second paragraph.)", assistance: "peer", sharedAt: "2026-11-10T14:00:00.000Z" },
        reviews: [review(1, "practiced", "peer", "hold", "Good start; arrange an independent check.")],
      }],
    },
    {
      studentId: "prn_sample-drew", displayName: "Drew Testfield", state: "encountered",
      evidence: [{
        opportunityId: id(304), planId: id(404), source: "teacher", task: "Argue for one recipe for the club, using evidence from two credible sources.",
        criteria: ["State a claim and organize reasons and relevant evidence clearly"], decision: "accepted",
        response: { text: "SAMPLE RESPONSE: Recipe A.", assistance: "unknown", sharedAt: "2026-11-11T14:00:00.000Z" }, reviews: [],
      }],
    },
    { studentId: "prn_sample-emery", displayName: "Emery Demo", state: "needs-evidence", evidence: [] },
  ],
} as const;
