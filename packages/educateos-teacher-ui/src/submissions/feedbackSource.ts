import type { FeedbackSource } from "../types.ts";

/**
 * Who a score or comment comes from, as the review shows it. A suggestion always names its kind,
 * a deterministic automatic check or an AI model, and nothing but the teacher's own entry is
 * theirs.
 */
export const sourceLabel = (source: FeedbackSource): "You" | "Automatic check" | "AI suggestion" => {
  if (source.kind === "teacher") return "You";
  return source.suggester.kind === "evaluator" ? "Automatic check" : "AI suggestion";
};

/** The badge colour for a source, so suggestions never look like the teacher's own entries. */
export const sourceBadge = (source: FeedbackSource): "neutral" | "teal" | "purple" =>
  source.kind === "teacher" ? "neutral" : source.suggester.kind === "evaluator" ? "teal" : "purple";

/** Recorded source identifier, without inferring a model's reasoning or verified authorship. */
export const sourceDetail = (source: FeedbackSource): string | undefined => {
  if (source.kind === "teacher") return undefined;
  return source.suggester.kind === "ai"
    ? `Model: ${source.suggester.modelId}`
    : `Evaluator: ${source.suggester.evaluatorId}`;
};
