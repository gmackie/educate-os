// How the quiz screens put dates, scores and item types into words.
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

const pad = (n: number) => String(n).padStart(2, "0");

/** An ISO timestamp as a `datetime-local` input's value, in the device's zone. */
export const toLocalInput = (iso: string | undefined): string => {
  if (iso === undefined) return "";
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** A `datetime-local` input's value as an ISO timestamp, or undefined when it is empty or unreadable. */
export const fromLocalInput = (value: string): string | undefined => {
  if (value === "") return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};
