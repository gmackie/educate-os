// The words home learning shows parents for its states and sources (ADR-0016). Practice states
// describe practice, never mastery.
import type { RouteResponse } from "@educateos/api-client";

type Skill = RouteResponse<"family.progress">["skills"][number];

/** A skill's practice state, as a parent reads it. */
export const STATE_LABEL: Record<Skill["state"], string> = {
  "not-tried": "Not tried",
  "practicing-with-help": "Practicing with help",
  "practicing-independently": "Practicing independently",
  "ready-to-revisit": "Ready to revisit",
};

/** What each state means. */
export const STATE_HELP: Record<Skill["state"], string> = {
  "not-tried": "Nothing has been practiced for this skill yet.",
  "practicing-with-help": "Practiced, but not yet right on the first try without help often enough, on more than one day.",
  "practicing-independently": "At least 5 of the last 6 answers were right on the first try with no hint or help, across at least two days. This is not a mastery claim.",
  "ready-to-revisit": "Was practiced independently, but not for three weeks. A short review keeps it fresh.",
};

/** The Kumo badge variant for a state. */
export const STATE_BADGE: Record<Skill["state"], "neutral" | "info" | "success" | "warning"> = {
  "not-tried": "neutral",
  "practicing-with-help": "info",
  "practicing-independently": "success",
  "ready-to-revisit": "warning",
};

/** A track's name. */
export const TRACK_LABEL = { reading: "Reading", math: "Math" } as const;

/** A strand's name. */
export const STRAND_LABEL: Record<string, string> = {
  "phonemic-awareness": "Hearing sounds",
  decoding: "Reading words",
  spelling: "Spelling",
  "heart-words": "Heart words",
  "connected-text": "Reading sentences",
  "listening-comprehension": "Listening and understanding",
  counting: "Counting",
  comparing: "Comparing",
  "number-line": "Number line",
  addition: "Adding",
  subtraction: "Subtracting",
};

/** Where a response's evidence came from. */
export const EVIDENCE_LABEL = {
  captured: "Your child's own answer",
  "adult-presented": "Answered after you said the sounds",
  "adult-observed": "You listened and recorded it",
} as const;

/** The grade bands a child may start from. */
export const GRADE_BANDS = [
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "Grade 1" },
  { value: "2", label: "Grade 2" },
] as const;

/** The avatars a child may pick, as the server allows them, each with a spoken name. */
export const AVATARS = [
  ["🦊", "fox"], ["🐢", "turtle"], ["🦉", "owl"], ["🐙", "octopus"], ["🦁", "lion"], ["🐼", "panda"],
  ["🐸", "frog"], ["🦋", "butterfly"], ["🐳", "whale"], ["🦄", "unicorn"], ["🐝", "bee"], ["🚀", "rocket"],
] as const;

/** An avatar's spoken name. */
export const avatarName = (avatar: string): string => AVATARS.find(([emoji]) => emoji === avatar)?.[1] ?? "picture";
