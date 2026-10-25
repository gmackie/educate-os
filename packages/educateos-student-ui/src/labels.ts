// The words the Learning Home uses. Kept together so the privacy wording, which the acceptance
// criterion depends on, is one string everywhere it appears.
import type { ActivityContent } from "./model.ts";

/** Who can see a place's work, in the student's terms. */
export const PRIVACY_LABEL = {
  personal: "Only you can see this",
  course: "Your teacher can see work you submit or share",
} as const;

const SUBJECTS: Readonly<Record<ActivityContent["subject"], string>> = {
  "english-language-arts": "English Language Arts",
  science: "Science",
  "history-social-studies": "History and Social Studies",
  mathematics: "Mathematics",
  arts: "Art",
  "world-languages": "World Languages",
  "computer-science": "Computer Science",
  "health-physical-education": "Health and PE",
  "social-emotional-learning": "Social and Emotional Learning",
  other: "Course",
};

/**
 * A course's name, from what its activities say about it. The student API does not name a class
 * yet, so its subject and grade band stand in until one does.
 */
export const courseTitle = (activities: readonly { activity: { content: ActivityContent } }[]): string => {
  const content = activities[0]?.activity.content;
  if (content === undefined) return "Course";
  const band = content.gradeBand.includes("-") ? `Grades ${content.gradeBand.replace("-", "–")}` : `Grade ${content.gradeBand}`;
  return `${SUBJECTS[content.subject]} · ${band}`;
};

const dateTime = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A date and time the way a student reads it, such as "Tue, Oct 20, 3:05 PM". */
export const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));

/**
 * The short code a student can quote to prove what they handed in: the first twelve hex digits of
 * the submission's digest, in groups of four. It names the receipt; the full digest stays on it.
 */
export const receiptCode = (digest: string): string =>
  (digest.replace(/^sha256:/, "").slice(0, 12).toUpperCase().match(/.{1,4}/g) ?? []).join("-");

/** A rubric criterion's identifier as a heading, such as "use-of-evidence" → "Use of evidence". */
export const criterionLabel = (criterionId: string): string => {
  const words = criterionId.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** How much help the activity's helper may give, in the student's terms. */
export const AI_HELP_LABEL = {
  full: "The class helper can help you with this activity.",
  "hints-only": "The class helper can give you hints, but it won't do the work for you.",
  none: "There's no helper for this activity.",
} as const satisfies Record<ActivityContent["aiHelp"], string>;
