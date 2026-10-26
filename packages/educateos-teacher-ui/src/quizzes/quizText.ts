// How the quiz screens put scores and item types into words.
import type { QuizItem } from "../types.ts";

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
