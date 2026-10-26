// The words the Learning Home uses. Kept together so the privacy wording, which the acceptance
// criterion depends on, is one string everywhere it appears.
import type { ActivityContent, StudentOffering } from "./model.ts";

/** Who can see a place's work, in the student's terms. */
export const PRIVACY_LABEL = {
  personal: "Only you can see this",
  course: "Your teacher can see work you submit or share",
} as const;

/** A class's name: its course and section, such as "Earth Science · Tuesday mornings". */
export const classTitle = ({ course, offering }: { course: { title: string }; offering: { sectionName?: string } }): string =>
  offering.sectionName === undefined || offering.sectionName === "" ? course.title : `${course.title} · ${offering.sectionName}`;

/** The name of one of the student's classes, from their list of classes (SCHO-222). */
export const classTitleIn = (offerings: readonly StudentOffering[], offeringId: string): string => {
  const found = offerings.find((entry) => entry.offering.id === offeringId);
  return found === undefined ? "Your class" : classTitle(found);
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
