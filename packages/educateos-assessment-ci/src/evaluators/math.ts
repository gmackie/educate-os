// The built-in math answer evaluator.
import { z } from "zod";
import { ArithmeticError, MAX_EXPRESSION_LENGTH, evaluateArithmetic, standaloneKit } from "../math.ts";
import { defineEvaluator, type EvaluationArtifact } from "../sdk.ts";
import { lines } from "../text.ts";
import { WRITTEN_WORK, excerptOf } from "./writing.ts";

/** A problem number as students write it: `3`, `4b`. */
const ProblemId = z.string().regex(/^[A-Za-z0-9]{1,8}$/, "expected a problem number such as 3 or 4b");

/** An answer key entry: arithmetic in the safe subset, read when the rubric is signed. */
const AnswerExpression = z.string().trim().min(1).max(MAX_EXPRESSION_LENGTH).refine((source) => {
  try {
    evaluateArithmetic(source, standaloneKit());
    return true;
  } catch (error) {
    if (error instanceof ArithmeticError) return false;
    throw error;
  }
}, "expected a number or arithmetic expression");

/** `3. 3/4`, `Q3: 0.75`, `Problem 4b) x = 12`: the problem number, then the answer. */
const ANSWER_LINE = /^\s*(?:(?:problem|question|q)\s*)?([A-Za-z0-9]{1,8})\s*[.):]\s*(.+?)\s*$/i;

interface Answer {
  artifact: EvaluationArtifact;
  text: string;
  range: { start: number; end: number };
}

function shown(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/**
 * `math.answers`: each problem's answer, written on its own line as `<number>. <answer>`, equals the
 * answer key within a tolerance. An answer may be a number or arithmetic in the safe subset
 * (`3/4`, `2^3 - 1`); after an `=` only the last side counts (`x = 12`). The key is an answer key,
 * so this check is always teacher-only.
 */
export const mathAnswers = defineEvaluator({
  id: "math.answers",
  release: "1.0.0",
  accepts: WRITTEN_WORK,
  answerKeyed: true,
  config: z.strictObject({
    problems: z.array(z.strictObject({
      id: ProblemId,
      answer: AnswerExpression,
      tolerance: z.number().nonnegative().default(0),
    })).min(1).max(200).refine((problems) => new Set(problems.map((p) => p.id.toLowerCase())).size === problems.length, "problem numbers are unique"),
  }),
  evaluate(input, config, kit) {
    const answers = new Map<string, Answer>();
    for (const artifact of input.artifacts) {
      for (const line of lines(artifact.text, kit)) {
        const match = ANSWER_LINE.exec(line.text);
        if (match === null) continue;
        const id = match[1]!.toLowerCase();
        if (answers.has(id)) continue;
        const written = match[2]!;
        const answerStart = line.start + line.text.lastIndexOf(written);
        const equals = written.lastIndexOf("=");
        const answer = equals === -1 ? written : written.slice(equals + 1).trim();
        const start = equals === -1 ? answerStart : answerStart + written.lastIndexOf(answer);
        if (answer !== "") answers.set(id, { artifact, text: answer, range: { start, end: start + answer.length } });
      }
    }
    return config.problems.map((problem) => {
      const expected = evaluateArithmetic(problem.answer, kit);
      const answer = answers.get(problem.id.toLowerCase());
      if (answer === undefined) {
        return { criterionId: input.criterionId, observation: `Problem ${problem.id}: no answer`, passed: false, excerpts: [], explanation: `No line starting "${problem.id}." was found.` };
      }
      let value: number;
      try {
        value = evaluateArithmetic(answer.text, kit);
      } catch (error) {
        if (!(error instanceof ArithmeticError)) throw error;
        return {
          criterionId: input.criterionId,
          observation: `Problem ${problem.id}: answer not readable`,
          passed: false,
          excerpts: [excerptOf(answer.artifact, answer.range)],
          explanation: `"${answer.text}" is not a number or arithmetic expression: ${error.message}`,
        };
      }
      const correct = Math.abs(value - expected) <= problem.tolerance;
      return {
        criterionId: input.criterionId,
        observation: `Problem ${problem.id}: ${correct ? "correct" : "incorrect"}`,
        passed: correct,
        excerpts: [excerptOf(answer.artifact, answer.range)],
        explanation: `The answer "${answer.text}" is ${shown(value)}; the key is ${problem.answer} (${shown(expected)})${problem.tolerance === 0 ? "" : ` ± ${shown(problem.tolerance)}`}.`,
      };
    });
  },
});
