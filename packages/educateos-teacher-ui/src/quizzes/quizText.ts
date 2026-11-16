// How the quiz screens put scores and item types into words.
import type { ExtendedTime, QuizItem } from "../types.ts";

/** Points without float noise: whole numbers plainly, others to two places. */
export const formatPoints = (points: number): string => (Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/0+$/, ""));

/** Each item type's name in the builder. */
export const ITEM_TYPE_LABEL: Record<QuizItem["type"], string> = {
  "multiple-choice": "Multiple choice",
  "multiple-select": "Multiple select",
  "true-false": "True or false",
  numeric: "Number",
  "short-answer": "Short answer",
  essay: "Essay",
};

/** Minutes in words, to the nearest half minute: "45 minutes", "67.5 minutes". */
const minutesLabel = (minutes: number): string => {
  const rounded = Math.round(minutes * 2) / 2;
  return `${formatPoints(rounded)} minute${rounded === 1 ? "" : "s"}`;
};

/** A student's extended time in words, with what it comes to under the quiz's time limit, if it has one. */
export const extendedTimeLabel = (extendedTime: ExtendedTime, timeLimitMinutes: number | undefined): string => {
  if (extendedTime === "unlimited") return "No time limit";
  const multiple = `${formatPoints(extendedTime)}× time`;
  return timeLimitMinutes === undefined ? multiple : `${multiple} (${minutesLabel(timeLimitMinutes * extendedTime)})`;
};
