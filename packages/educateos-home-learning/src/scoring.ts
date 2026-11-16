// Deterministic scoring of one practice response (ADR-0016). The child's screen uses it for
// immediate, calm feedback, and the server runs it again on save: what is stored is always the
// server's result, computed from the pinned item, never the client's claim.
import { z } from "zod";
import { EducateOsError } from "@educateos/contracts";
import type { ActivityMode, Item } from "./content/schema.ts";

/** One try at an item, in the shape its type expects. */
export const Answer = z.discriminatedUnion("kind", [
  /** A tapped choice, by key (or `left`/`right` for a comparison). */
  z.strictObject({ kind: z.literal("choice"), choice: z.string().min(1).max(32) }),
  /** A number: a count, or where on a number line. `path` is the marks a jump passed through, in order. */
  z.strictObject({ kind: z.literal("number"), value: z.int().min(-50).max(50), path: z.array(z.int().min(-50).max(50)).max(25).optional() }),
  /** Letter tiles, in the order tapped. */
  z.strictObject({ kind: z.literal("letters"), letters: z.array(z.string().regex(/^[a-z]{1,2}$/)).min(1).max(12) }),
  /** What the adult recorded for oral reading they listened to. */
  z.strictObject({ kind: z.literal("observed"), result: z.enum(["independent", "with-help", "not-yet"]) }),
]);
/** An answer. */
export type Answer = z.infer<typeof Answer>;

/**
 * Where a response's evidence came from. `captured`: the child's own tap or build. `adult-presented`:
 * the child answered, but an adult spoke the stimulus (blending sounds from the guide).
 * `adult-observed`: the adult listened and recorded the result; the app heard nothing.
 */
export const EvidenceSource = z.enum(["captured", "adult-presented", "adult-observed"]);
/** An evidence source. */
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** A recognisable mistake worth naming to a parent. */
export const ErrorPattern = z.enum([
  /** On a number line, counted the starting mark as the first jump (6 + 3 → 8). */
  "counted-start-mark",
  /** On a number line, jumped the wrong way. */
  "jumped-wrong-way",
  /** Built a word from the right letters in the wrong order. */
  "letters-out-of-order",
]);
/** An error pattern. */
export type ErrorPattern = z.infer<typeof ErrorPattern>;

const sortedLetters = (word: string) => word.split("").toSorted().join("");

/** The answer kind each item type takes. */
export function answerKindFor(item: Item): Answer["kind"] {
  switch (item.type) {
    case "count-sounds":
    case "count-objects":
    case "one-more-less":
    case "place-on-line":
    case "number-line-jump":
      return "number";
    case "build-word":
      return "letters";
    case "read-aloud":
      return "observed";
    default:
      return "choice";
  }
}

/** Where an item's evidence comes from. */
export function evidenceSourceFor(item: Item): EvidenceSource {
  if (item.type === "blend-sounds") return "adult-presented";
  if (item.type === "read-aloud") return "adult-observed";
  return "captured";
}

/** The result of one try. */
export interface TryResult {
  correct: boolean;
  pattern?: ErrorPattern;
}

/**
 * Scores one try at an item.
 *
 * @throws EducateOsError `validation-failed` if the answer is not the kind the item takes.
 */
export function scoreTry(item: Item, answer: Answer): TryResult {
  if (answer.kind !== answerKindFor(item)) {
    throw new EducateOsError("validation-failed", `This item takes a ${answerKindFor(item)} answer.`);
  }
  switch (item.type) {
    case "count-sounds":
    case "count-objects":
    case "one-more-less":
    case "place-on-line":
      return { correct: (answer as { value: number }).value === item.answer };
    case "number-line-jump": {
      const { value } = answer as { value: number };
      if (value === item.answer) return { correct: true };
      const sign = Math.sign(item.change);
      if (value === item.answer - sign) return { correct: false, pattern: "counted-start-mark" };
      if (value === item.start - item.change) return { correct: false, pattern: "jumped-wrong-way" };
      return { correct: false };
    }
    case "build-word": {
      const built = (answer as { letters: string[] }).letters.join("");
      if (built === item.answer) return { correct: true };
      return sortedLetters(built) === sortedLetters(item.answer) ? { correct: false, pattern: "letters-out-of-order" } : { correct: false };
    }
    case "read-aloud":
      // Read with help still read the sentence; only "on their own" is independent (below).
      return { correct: (answer as { result: string }).result !== "not-yet" };
    default:
      return { correct: (answer as { choice: string }).choice === item.answer };
  }
}

/** How many tries an item allows in each mode. A check gives one try and no hints. */
export function triesAllowed(mode: ActivityMode, item: Item): number {
  if (item.type === "read-aloud") return 1;
  return mode === "check" ? 1 : 2;
}

/** What a client sends when an item is finished. */
export const ResponseInput = z.strictObject({
  /** A fresh UUID per item response, so a retried save is recognised and not counted twice. */
  requestId: z.uuid(),
  item: z.string().min(1).max(64),
  /** Each try, in order. */
  answers: z.array(Answer).min(1).max(2),
  /** The child asked for the worked hint before finishing. */
  hintUsed: z.boolean(),
  /** The child asked their grown-up for help. */
  adultHelped: z.boolean(),
});
/** A response input. */
export type ResponseInput = z.infer<typeof ResponseInput>;

/** A response as stored: the input, and what the server derived from it. */
export const ScoredResponse = z.strictObject({
  ...ResponseInput.shape,
  savedAt: z.iso.datetime({ offset: true }),
  /** The last try was right. */
  correct: z.boolean(),
  /** The first try was right. */
  firstTryCorrect: z.boolean(),
  /**
   * Right on the first try with no hint and no adult help, and (for oral reading) the adult
   * recorded "on their own". This is what progress counts as independent.
   */
  independent: z.boolean(),
  evidence: EvidenceSource,
  pattern: ErrorPattern.optional(),
});
/** A scored response. */
export type ScoredResponse = z.infer<typeof ScoredResponse>;

/**
 * Scores a finished item for storage.
 *
 * @throws EducateOsError `validation-failed` if it has more tries than the mode allows, a hint in
 *   a check, a try after a correct one, or an answer of the wrong kind.
 */
export function scoreResponse(item: Item, mode: ActivityMode, input: ResponseInput, savedAt: string): ScoredResponse {
  if (input.item !== item.key) throw new EducateOsError("validation-failed", "The response names a different item.");
  if (input.answers.length > triesAllowed(mode, item)) throw new EducateOsError("validation-failed", "This item allows fewer tries.");
  if (mode === "check" && input.hintUsed) throw new EducateOsError("validation-failed", "A check has no hints.");
  const tries = input.answers.map((answer) => scoreTry(item, answer));
  if (tries.slice(0, -1).some((t) => t.correct)) throw new EducateOsError("validation-failed", "A try came after a correct answer.");
  const first = tries[0]!;
  const last = tries.at(-1)!;
  const pattern = tries.find((t) => t.pattern !== undefined)?.pattern;
  return ScoredResponse.parse({
    ...input,
    savedAt,
    correct: last.correct,
    firstTryCorrect: first.correct,
    independent: first.correct && !input.hintUsed && !input.adultHelped && !observedWithHelp(input.answers[0]!),
    evidence: evidenceSourceFor(item),
    ...(pattern === undefined ? {} : { pattern }),
  });
}

const observedWithHelp = (answer: Answer): boolean => answer.kind === "observed" && answer.result !== "independent";
