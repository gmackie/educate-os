import { EvaluatorRegistry } from "../registry.ts";
import type { Evaluator } from "../sdk.ts";
import { citationFormat } from "./citations.ts";
import { mathAnswers } from "./math.ts";
import { datasetStructure, spreadsheetAssertions, spreadsheetComputedValue } from "./tables.ts";
import { contentRequired, writingStructure } from "./writing.ts";

export { citationFormat, CitationStyle } from "./citations.ts";
export { mathAnswers } from "./math.ts";
export { Aggregate, datasetStructure, spreadsheetAssertions, spreadsheetComputedValue } from "./tables.ts";
export { contentRequired, writingStructure } from "./writing.ts";

/** Every built-in evaluator release: the minimum evaluator groups of roadmap §7. */
export const BUILTIN_EVALUATORS: readonly Evaluator[] = Object.freeze([
  contentRequired,
  writingStructure,
  citationFormat,
  spreadsheetAssertions,
  spreadsheetComputedValue,
  datasetStructure,
  mathAnswers,
]);

/** A registry of the built-in evaluators, each pinned to its release, plus any `extra` releases (unpinned). */
export function builtinRegistry(extra: readonly Evaluator[] = []): EvaluatorRegistry {
  return new EvaluatorRegistry([...BUILTIN_EVALUATORS, ...extra], Object.fromEntries(BUILTIN_EVALUATORS.map((e) => [e.id, e.release])));
}
