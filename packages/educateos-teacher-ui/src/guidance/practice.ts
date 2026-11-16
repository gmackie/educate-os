/**
 * The fixed practice invitations a teacher can send (CASEL practice). The wording is the district
 * app's `PRACTICE_CATALOG`, mirrored here because Teacher Studio reaches the district only through
 * the typed API client; a test keeps the two identical. A teacher chooses a skill, never the
 * words, so no invitation can ask about feelings, home life or behaviour.
 */
export const PRACTICE_PROMPTS = {
  teamwork: { title: "Team practice", area: "Relationship skills", prompt: "Next time you work with others, try one thing: ask a teammate what they think before the group decides." },
  planning: { title: "Planning practice", area: "Self-management", prompt: "Before you start your next project, write your first three steps and when you could do each one." },
  communication: { title: "Communication practice", area: "Relationship skills", prompt: "Explain one idea from this class to someone in your own words, then ask if it made sense." },
} as const;

/** A practice skill. */
export type PracticeSkill = keyof typeof PRACTICE_PROMPTS;

/** The words a student's state is shown in. Each says what the evidence is, never what the student is like. */
export const MASTERY_LABELS = {
  "needs-evidence": "Needs evidence",
  "encountered": "Encountered",
  "practiced": "Practiced",
  "independent-reviewed": "Independent, teacher-reviewed",
} as const;

/** Mastery states in the order a bar and its legend show them. */
export const MASTERY_ORDER = ["needs-evidence", "encountered", "practiced", "independent-reviewed"] as const;

/** The standard states, in words a teacher can act on. */
export const STANDARD_STATE_TEXT = {
  "approved": "Approved for your district",
  "hidden": "Hidden by your district",
  "not-approved": "Not approved (withdrawn)",
  "unmapped": "Unmapped: not in any approved release",
} as const;
