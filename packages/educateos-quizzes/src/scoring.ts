// Deterministic scoring and ordering of quiz attempts (SCHO-191). Scoring runs on the server when an
// attempt is submitted; nothing here calls a model, so AI never scores an item. Essays are left for
// a teacher. An attempt's order is derived from its seed, so it is the same every time it is shown.
import { MAX_SHORT_ANSWER_LENGTH, type ItemScore, type QuizAnswer, type QuizItem, type QuizResponse } from "./model.ts";

/** Points are kept to this many decimal places, so partial credit adds up without float noise. */
const PLACES = 4;
const round = (value: number) => Math.round(value * 10 ** PLACES) / 10 ** PLACES;

/** Short answers are compared trimmed, with runs of white space as one space, and case-insensitively. */
export function normalizeShortAnswer(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/**
 * The points one response earns on one item, or null for an essay, which a teacher grades. A
 * missing response, or one of another item type, earns nothing.
 */
export function scoreResponse(item: QuizItem, response: QuizResponse | undefined): number | null {
  if (item.type === "essay") return null;
  if (response === undefined || response.type !== item.type) return 0;
  switch (item.type) {
    case "multiple-choice":
      return (response as Extract<QuizResponse, { type: "multiple-choice" }>).choiceId === item.correctChoiceId ? item.points : 0;
    case "true-false":
      return (response as Extract<QuizResponse, { type: "true-false" }>).value === item.correct ? item.points : 0;
    case "numeric": {
      const { value } = response as Extract<QuizResponse, { type: "numeric" }>;
      // A hair of slack for decimal answers that floats cannot hold exactly, such as 0.1 + 0.2.
      return Math.abs(value - item.answer) <= item.tolerance + 1e-9 * Math.max(1, Math.abs(item.answer)) ? item.points : 0;
    }
    case "short-answer": {
      const text = (response as Extract<QuizResponse, { type: "short-answer" }>).text;
      if (text.length > MAX_SHORT_ANSWER_LENGTH) return 0;
      const given = normalizeShortAnswer(text);
      if (given === "") return 0;
      if (item.acceptedAnswers.some((accepted) => normalizeShortAnswer(accepted) === given)) return item.points;
      // The pattern passed `isSafePattern` when it was stored, and runs on at most 200 characters.
      return item.pattern !== undefined && new RegExp(`^(?:${item.pattern})$`, "iu").test(text.trim()) ? item.points : 0;
    }
    case "multiple-select": {
      const chosen = new Set((response as Extract<QuizResponse, { type: "multiple-select" }>).choiceIds);
      const correct = new Set(item.correctChoiceIds);
      const right = [...chosen].filter((id) => correct.has(id)).length;
      const wrong = [...chosen].filter((id) => !correct.has(id) && item.choices.some((c) => c.id === id)).length;
      if (item.scoring === "all-or-nothing") return right === correct.size && wrong === 0 ? item.points : 0;
      return round(item.points * Math.max(0, right - wrong) / correct.size);
    }
  }
}

/** The correct response to an item, for showing with answers; none for an essay or a pattern-only short answer. */
export function correctResponse(item: QuizItem): QuizResponse | undefined {
  switch (item.type) {
    case "multiple-choice":
      return { type: "multiple-choice", choiceId: item.correctChoiceId };
    case "multiple-select":
      return { type: "multiple-select", choiceIds: [...item.correctChoiceIds] };
    case "true-false":
      return { type: "true-false", value: item.correct };
    case "numeric":
      return { type: "numeric", value: item.answer };
    case "short-answer":
      return item.acceptedAnswers[0] === undefined ? undefined : { type: "short-answer", text: item.acceptedAnswers[0] };
    case "essay":
      return undefined;
  }
}

/** Scores every item of a submitted attempt, in the quiz's order. Essays wait for a teacher. */
export function scoreAttempt(items: readonly QuizItem[], answers: readonly QuizAnswer[]): ItemScore[] {
  const responses = new Map(answers.map((a) => [a.itemId, a.response]));
  return items.map((item) => ({ itemId: item.id, points: scoreResponse(item, responses.get(item.id)), maxPoints: item.points, source: "auto" as const }));
}

/** An attempt's total: its points and the most it could have, or null points while an item waits for a teacher. */
export function totalOf(scores: readonly ItemScore[]): { points: number | null; maxPoints: number } {
  const maxPoints = round(scores.reduce((sum, s) => sum + s.maxPoints, 0));
  if (scores.some((s) => s.points === null)) return { points: null, maxPoints };
  return { points: round(scores.reduce((sum, s) => sum + s.points!, 0)), maxPoints };
}

// Deterministic order. FNV-1a seeds a mulberry32 generator, which drives a Fisher-Yates shuffle.

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `values` in the order `seed` and `key` give them: the same order every time for the same seed and key. */
export function seededShuffle<T>(values: readonly T[], seed: string, key: string): T[] {
  const next = generator(hash(`${seed}:${key}`));
  const shuffled = [...values];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled;
}
