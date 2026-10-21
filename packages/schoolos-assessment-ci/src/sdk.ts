// The evaluator SDK's contracts. The shape of an evaluator result (an evaluator name, a pass/fail
// judgement and findings that quote the evidence they rest on) is adapted from PlayTrek's Hall
// Monitor, `packages/ai/src/hallMonitor/evaluators/types.ts` at commit 7258e4347. Here evidence is
// per rubric criterion, quotes the submitted work by revision and range rather than by copied
// text, and an evaluator is a pinned, versioned release with a config schema and a step budget.
import { z } from "zod";
import { ArtifactId, ArtifactType, ContentDigest, RevisionId } from "@schoolos/contracts";
import { CriterionId } from "@schoolos/assessment";
import { MediaType } from "@schoolos/learning-artifacts";

/**
 * Identifies an evaluator, independent of its release: lowercase dot-separated words such as
 * `citation.format`. It matches the evaluator name the assessment service's `Suggester` accepts.
 */
export const EvaluatorId = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/, "expected an evaluator ID such as citation.format").max(100);
/** An evaluator identifier. */
export type EvaluatorId = z.infer<typeof EvaluatorId>;

/** A semantic version, `major.minor.patch`, with no pre-release or build suffix. */
export const SemVer = z.string().regex(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/, "expected a version such as 1.0.0");
/** A semantic version. */
export type SemVer = z.infer<typeof SemVer>;

/** One release of one evaluator: what a run names, and what a suggestion is labelled with. */
export const EvaluatorRelease = z.strictObject({ id: EvaluatorId, release: SemVer });
/** An evaluator release. */
export type EvaluatorRelease = z.infer<typeof EvaluatorRelease>;

/** The label a suggestion from `release` carries in the assessment service: `<id>@<release>`. */
export function evaluatorLabel(release: EvaluatorRelease): string {
  return `${release.id}@${release.release}`;
}

/**
 * A place in a submitted revision: `[start, end)` in UTF-16 code units of its canonical text, the
 * same coordinates a feedback anchor's `text-range` uses.
 */
export const TextRange = z.strictObject({ start: z.int().nonnegative(), end: z.int().positive() }).refine((r) => r.start < r.end, "a range ends after it starts");
/** A text range. */
export type TextRange = z.infer<typeof TextRange>;

/** The part of the submitted work a piece of evidence rests on. Evidence quotes by reference, never by copy. */
export const Excerpt = z.strictObject({ artifact: ArtifactId, revision: RevisionId, range: TextRange });
/** An excerpt. */
export type Excerpt = z.infer<typeof Excerpt>;

/**
 * What one check observed about one rubric criterion. `observation` says what was found ("742
 * words"); `passed` and `score` (a fraction from 0 to 1) are present only when the check judges
 * something, and are absent for a plain observation; `explanation` says why, in terms a teacher
 * can verify against the excerpts.
 */
export const CriterionEvidence = z.strictObject({
  criterionId: CriterionId,
  observation: z.string().trim().min(1).max(500),
  passed: z.boolean().optional(),
  score: z.number().min(0).max(1).optional(),
  excerpts: z.array(Excerpt).max(50),
  explanation: z.string().trim().min(1).max(2000),
});
/** Criterion evidence. */
export type CriterionEvidence = z.infer<typeof CriterionEvidence>;

/** One submitted text revision as an evaluator reads it: frozen, verified against its digest. */
export interface EvaluationArtifact {
  readonly artifactId: ArtifactId;
  readonly revisionId: RevisionId;
  readonly digest: ContentDigest;
  readonly artifactType: ArtifactType;
  readonly mediaType: MediaType;
  /** The revision's canonical text. */
  readonly text: string;
}

/** What one check gives its evaluator. Deep-frozen. */
export interface EvaluationInput {
  /** The criterion the check belongs to; every piece of evidence returned names it. */
  readonly criterionId: CriterionId;
  /** The submitted artifacts the evaluator accepts, in canonical order. Never empty. */
  readonly artifacts: readonly EvaluationArtifact[];
}

/**
 * The whole API surface an evaluator may use beyond its input and config. Evaluation is metered in
 * abstract steps, so a run's CPU budget is the same on every machine and every retry.
 */
export interface EvaluationKit {
  /** Spends `units` steps (default 1). Throws once the run's step budget is exhausted. */
  step(units?: number): void;
}

/** The input an evaluator reads: artifact types and the text media types it understands. */
export interface AcceptedInput {
  readonly artifactTypes: readonly ArtifactType[];
  readonly mediaTypes: readonly MediaType[];
}

/**
 * A deterministic evaluator release. `evaluate` is pure: the same input and config always give the
 * same evidence. It runs synchronously against frozen values with the clock, randomness, timers
 * and the network withdrawn (see `runDeterministically`), and every unit of work it does is
 * metered through the kit.
 */
export interface Evaluator {
  readonly id: EvaluatorId;
  readonly release: SemVer;
  /** What it reads. A check whose submission holds none of it records that as failed evidence. */
  readonly accepts: AcceptedInput;
  /**
   * Whether its config holds an answer key or fixture (an expected value). Such a check reveals
   * the answer through its evidence, so a rubric may only bind it as `teacher-only`.
   */
  readonly answerKeyed: boolean;
  /** Validates the config a rubric check gives it. */
  readonly config: z.ZodType;
  /** Evaluates one check. `config` has already been parsed by {@link config}. */
  evaluate(input: EvaluationInput, config: unknown, kit: EvaluationKit): readonly CriterionEvidence[];
}

/** An evaluator's definition, with its config typed by its schema. */
export interface EvaluatorDefinition<S extends z.ZodType> {
  id: EvaluatorId;
  release: SemVer;
  accepts: AcceptedInput;
  answerKeyed: boolean;
  config: S;
  evaluate(input: EvaluationInput, config: z.output<S>, kit: EvaluationKit): readonly CriterionEvidence[];
}

/** Defines an evaluator, checking its ID and release and freezing it so a registered release cannot change. */
export function defineEvaluator<S extends z.ZodType>(definition: EvaluatorDefinition<S>): Evaluator {
  EvaluatorId.parse(definition.id);
  SemVer.parse(definition.release);
  return Object.freeze({
    id: definition.id,
    release: definition.release,
    accepts: Object.freeze({ artifactTypes: Object.freeze([...definition.accepts.artifactTypes]), mediaTypes: Object.freeze([...definition.accepts.mediaTypes]) }),
    answerKeyed: definition.answerKeyed,
    config: definition.config,
    // The engine parses `config` with `definition.config` before every call.
    evaluate: (input: EvaluationInput, config: unknown, kit: EvaluationKit) => definition.evaluate(input, config as z.output<S>, kit),
  });
}

/** Thrown when a run spends more steps than its execution profile allows. */
export class StepBudgetExceeded extends Error {
  constructor(maxSteps: number) {
    super(`The run used more than its budget of ${maxSteps} evaluation steps.`);
    this.name = "StepBudgetExceeded";
  }
}

/**
 * Counts a run's evaluation steps against its budget. Once exceeded it stays exceeded, so an
 * evaluator that catches the error cannot carry on and still complete the run.
 */
export class StepMeter implements EvaluationKit {
  readonly #maxSteps: number;
  #used = 0;

  constructor(maxSteps: number) {
    this.#maxSteps = maxSteps;
  }

  /** The steps spent so far. */
  get used(): number {
    return this.#used;
  }

  /** Whether the budget has been exceeded. */
  get exceeded(): boolean {
    return this.#used > this.#maxSteps;
  }

  step(units = 1): void {
    if (!Number.isInteger(units) || units < 0) throw new RangeError("steps are spent in whole, non-negative units");
    this.#used += units;
    if (this.exceeded) throw new StepBudgetExceeded(this.#maxSteps);
  }
}
