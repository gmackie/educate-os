// Quiz items of every type and answers to them, shared by the scoring and service suites.
import type { QuizItemDraft } from "../src/index.ts";

/** One item of each type, with distinctive keys the leak test looks for. */
export const ITEMS = {
  mc: {
    id: "qzi_mc",
    type: "multiple-choice",
    prompt: "Which organelle makes ATP?",
    points: 2,
    choices: [{ id: "a", text: "Nucleus" }, { id: "b", text: "Mitochondrion" }, { id: "c", text: "Ribosome" }],
    correctChoiceId: "b",
    feedback: "SECRET-FEEDBACK: the powerhouse.",
  },
  ms: {
    id: "qzi_ms",
    type: "multiple-select",
    prompt: "Which are found in plant cells?",
    points: 3,
    choices: [{ id: "wall", text: "Cell wall" }, { id: "chloro", text: "Chloroplast" }, { id: "centri", text: "Centriole" }, { id: "vac", text: "Large vacuole" }],
    correctChoiceIds: ["wall", "chloro", "vac"],
    scoring: "partial",
  },
  tf: { id: "qzi_tf", type: "true-false", prompt: "Viruses are cells.", points: 1, correct: false },
  num: { id: "qzi_num", type: "numeric", prompt: "Human chromosome count?", points: 1, answer: 46, tolerance: 0.5 },
  short: { id: "qzi_short", type: "short-answer", prompt: "Name the process plants use to make sugar.", points: 1, acceptedAnswers: ["photosynthesis"], pattern: "photo-?synthesis" },
  essay: { id: "qzi_essay", type: "essay", prompt: "Explain osmosis.", points: 5 },
} as const satisfies Record<string, QuizItemDraft>;

/** Correct answers to every auto-scored item, and an essay. */
export const RIGHT = [
  { itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "b" } },
  { itemId: "qzi_ms", response: { type: "multiple-select", choiceIds: ["wall", "chloro", "vac"] } },
  { itemId: "qzi_tf", response: { type: "true-false", value: false } },
  { itemId: "qzi_num", response: { type: "numeric", value: 46.2 } },
  { itemId: "qzi_short", response: { type: "short-answer", text: "  Photo-Synthesis " } },
  { itemId: "qzi_essay", response: { type: "essay", text: "Water moves across a membrane toward the solute." } },
] as const;
