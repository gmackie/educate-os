import { z } from "zod";
import { AssessmentRunId, ContentDigest, RubricId } from "@educateos/contracts";
import { CriterionId, RubricReleaseRef, recordFormat } from "@educateos/assessment";
import { CheckVisibility } from "./rubric.ts";
import { CriterionEvidence, EvaluatorRelease } from "./sdk.ts";

/** Names an execution profile and its version: `deterministic@1`. A profile never changes once named. */
export const ExecutionProfileId = z.string().regex(/^[a-z][a-z0-9-]*@[0-9]+$/, "expected a profile such as deterministic@1");
/** An execution profile identifier. */
export type ExecutionProfileId = z.infer<typeof ExecutionProfileId>;

/**
 * The limits a run executes under (roadmap §7): CPU time as a budget of evaluation steps, the
 * total size of the submitted work, how many times a run is attempted again after a transient
 * failure, and cost, in nanodollars (ADR-0008). Deterministic evaluation calls no model, so its
 * cost limit is zero.
 */
export const ExecutionLimits = z.strictObject({
  maxSteps: z.int().positive().max(100_000_000),
  maxInputBytes: z.int().positive().max(64 * 1024 * 1024),
  maxRetries: z.int().nonnegative().max(10),
  maxCostUsdNano: z.literal("0"),
});
/** Execution limits. */
export type ExecutionLimits = z.infer<typeof ExecutionLimits>;

/** How a run executes. E02 has only deterministic, in-process evaluation; E03 adds AI and sandboxed profiles. */
export const ExecutionProfile = z.strictObject({
  id: ExecutionProfileId,
  kind: z.literal("deterministic"),
  limits: ExecutionLimits,
});
/** An execution profile. */
export type ExecutionProfile = z.infer<typeof ExecutionProfile>;

/** The default profile: a million steps (well over a long essay or a lab's CSV), 2 MiB of work, two retries. */
export const DETERMINISTIC_PROFILE: ExecutionProfile = Object.freeze({
  id: "deterministic@1",
  kind: "deterministic",
  limits: Object.freeze({ maxSteps: 1_000_000, maxInputBytes: 2 * 1024 * 1024, maxRetries: 2, maxCostUsdNano: "0" }),
});

/** Distinguishes runs that are otherwise identical, such as a teacher's deliberate re-run. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "expected up to 128 letters, digits and . _ : -");
/** An idempotency key. */
export type IdempotencyKey = z.infer<typeof IdempotencyKey>;

/**
 * What an assessment run is (roadmap §7), and its identity: the same key is always the same run.
 *
 * - `submissionDigest`: the exact submitted work, as the assessment service's submission digest.
 * - `rubricRelease`: the signed rubric release, which fixes the criteria, checks and fixtures.
 * - `evaluatorRelease`: the digest of the exact evaluator releases the rubric's checks resolved to
 *   (see `evaluatorSetDigest`), so a new release of any of them is a new run.
 * - `executionProfile`: the limits it runs under.
 * - `idempotencyKey`: the caller's name for this request.
 */
export const AssessmentRunKey = z.strictObject({
  submissionDigest: ContentDigest,
  rubricRelease: RubricReleaseRef,
  evaluatorRelease: ContentDigest,
  executionProfile: ExecutionProfileId,
  idempotencyKey: IdempotencyKey,
});
/** An assessment run key. */
export type AssessmentRunKey = z.infer<typeof AssessmentRunKey>;

/** Where a run is: `queued`, `running`, then `completed` or `failed`, which are final. */
export const RunState = z.enum(["queued", "running", "completed", "failed"]);
/** A run state. */
export type RunState = z.infer<typeof RunState>;

/**
 * Why a run failed. Every reason but `retries-exhausted` is deterministic: running the same key
 * again would fail the same way, so none of them is retried.
 */
export const RunErrorCode = z.enum([
  "step-budget-exceeded",
  "input-too-large",
  "invalid-config",
  "integrity",
  "evaluator-unavailable",
  "evaluator-error",
  "nondeterministic-evaluator",
  "rubric-not-authorized",
  "retries-exhausted",
]);
/** A run error code. */
export type RunErrorCode = z.infer<typeof RunErrorCode>;

/** A failed run's reason, for the teacher. */
export const RunError = z.strictObject({ code: RunErrorCode, message: z.string().min(1).max(1000) });
/** A run error. */
export type RunError = z.infer<typeof RunError>;

/** One check's evidence in a report. */
export const CheckResult = z.strictObject({
  checkId: z.string(),
  evaluator: EvaluatorRelease,
  visibility: CheckVisibility,
  evidence: z.array(CriterionEvidence),
});
/** A check result. */
export type CheckResult = z.infer<typeof CheckResult>;

/**
 * A criterion score one evaluator's evidence suggests: the highest level whose points do not exceed
 * the mean of its judged evidence (passed counting 1, failed 0, or its score) times the
 * criterion's maximum. Only ever a suggestion.
 */
export const CriterionSuggestion = z.strictObject({
  evaluator: EvaluatorRelease,
  levelId: z.string(),
  points: z.number().nonnegative(),
  maxPoints: z.number().positive(),
});
/** A criterion suggestion. */
export type CriterionSuggestion = z.infer<typeof CriterionSuggestion>;

/** Everything a run found for one criterion. */
export const CriterionReport = z.strictObject({
  criterionId: CriterionId,
  title: z.string(),
  checks: z.array(CheckResult),
  suggestions: z.array(CriterionSuggestion),
});
/** A criterion report. */
export type CriterionReport = z.infer<typeof CriterionReport>;

/** Counts over a report's evidence: judged evidence that passed or failed, and plain observations. */
export const ReportSummary = z.strictObject({
  criteria: z.int().nonnegative(),
  checks: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  observations: z.int().nonnegative(),
  text: z.string(),
});
/** A report summary. */
export type ReportSummary = z.infer<typeof ReportSummary>;

/**
 * What a completed run found. It depends on the run key alone: it holds no times or attempt
 * counts, so the same key always gives byte-for-byte the same report.
 */
export const AssessmentReport = z.strictObject({
  format: recordFormat("assessment-report.v2"),
  runId: AssessmentRunId,
  key: AssessmentRunKey,
  rubricDigest: ContentDigest,
  criteria: z.array(CriterionReport),
  summary: ReportSummary,
  /** Every evaluator release the run used, sorted by ID. */
  evaluatorReleases: z.array(EvaluatorRelease),
  stepsUsed: z.int().nonnegative(),
  /** What the run cost, in nanodollars: always nothing, since deterministic evaluation calls no model. */
  costUsdNano: z.literal("0"),
});
/** An assessment report. */
export type AssessmentReport = z.infer<typeof AssessmentReport>;

/**
 * A report as the student sees it: only student-visible checks, only criteria that have one, no
 * suggested scores, and no run key or fixture digest.
 */
export const StudentAssessmentReport = z.strictObject({
  format: recordFormat("assessment-report.student.v1"),
  runId: AssessmentRunId,
  rubric: z.strictObject({ rubricId: RubricId, version: z.int().positive() }),
  criteria: z.array(z.strictObject({ criterionId: CriterionId, title: z.string(), checks: z.array(CheckResult) })),
  summary: ReportSummary,
});
/** A student assessment report. */
export type StudentAssessmentReport = z.infer<typeof StudentAssessmentReport>;

/**
 * One durable assessment run. `report` is present exactly when it completed and `error` exactly
 * when it failed. `evaluators` are the releases resolved when it was queued, which it executes
 * even if the registry's pins have moved since.
 */
export const AssessmentRun = z.strictObject({
  id: AssessmentRunId,
  key: AssessmentRunKey,
  evaluators: z.array(EvaluatorRelease),
  state: RunState,
  /** Increases by one with every stored change; what the store's optimistic check compares. */
  revision: z.int().nonnegative(),
  /** How many times execution has started. */
  attempts: z.int().nonnegative(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  /** The transient failure that sent the run back to `queued`, if one did. */
  lastAttemptError: z.string().max(1000).optional(),
  report: AssessmentReport.optional(),
  error: RunError.optional(),
}).refine((r) => (r.state === "completed") === (r.report !== undefined) && (r.state === "failed") === (r.error !== undefined), "a completed run has a report and a failed run an error");
/** An assessment run. */
export type AssessmentRun = z.infer<typeof AssessmentRun>;
