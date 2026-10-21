import { z } from "zod";
import { ActivityId, AssessmentRunId, DistrictId, OfferingId, PrincipalId, SubmissionId, UsdNano } from "@schoolos/contracts";
import { CriterionId } from "@schoolos/assessment";
import { AssessmentRunKey, CheckVisibility, CriterionEvidence, EvaluatorRelease, RunState } from "@schoolos/assessment-ci";
import { AI_SUGGESTED, AiFeedbackConfig, AiOutcome } from "./ai-feedback.ts";
import { ModelRef } from "./model-port.ts";
import { AiHelpPolicy } from "./profiles.ts";
import { SandboxCheck, SandboxLimit } from "./sandbox.ts";

/** What an optional run evaluates: AI feedback under a teacher's config, or the teacher's executable checks. */
export const OptionalRunSpec = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ai"), evaluator: EvaluatorRelease, model: ModelRef, config: AiFeedbackConfig }),
  z.strictObject({
    kind: z.literal("sandbox"),
    evaluator: EvaluatorRelease,
    checks: z.array(SandboxCheck).min(1).max(20).refine((checks) => new Set(checks.map((c) => c.id)).size === checks.length, "check IDs are unique"),
  }),
]);
/** An optional run spec. */
export type OptionalRunSpec = z.infer<typeof OptionalRunSpec>;

/** What an AI run found, labelled `ai-suggested` throughout. It is never official. */
export const AiFeedbackReport = z.strictObject({
  kind: z.literal("ai"),
  format: z.literal("schoolos.ai-feedback-report.v2"),
  runId: AssessmentRunId,
  key: AssessmentRunKey,
  label: z.literal(AI_SUGGESTED),
  evaluator: EvaluatorRelease,
  model: ModelRef,
  outcome: AiOutcome,
  /** What the model request cost, in nanodollars. */
  costUsdNano: UsdNano,
});
/** An AI feedback report. */
export type AiFeedbackReport = z.infer<typeof AiFeedbackReport>;

/** One executable check's result in a sandbox report. */
export const SandboxCheckResult = z.strictObject({
  checkId: z.string(),
  criterionId: CriterionId,
  visibility: CheckVisibility,
  limit: SandboxLimit.optional(),
  evidence: CriterionEvidence,
});
/** A sandbox check result. */
export type SandboxCheckResult = z.infer<typeof SandboxCheckResult>;

/** What a sandboxed run found. */
export const SandboxReport = z.strictObject({
  kind: z.literal("sandbox"),
  format: z.literal("schoolos.sandbox-report.v2"),
  runId: AssessmentRunId,
  key: AssessmentRunKey,
  evaluator: EvaluatorRelease,
  checks: z.array(SandboxCheckResult),
  /** What the run's checks cost together, in nanodollars. */
  costUsdNano: UsdNano,
});
/** A sandbox report. */
export type SandboxReport = z.infer<typeof SandboxReport>;

/** An optional run's report. */
export const OptionalRunReport = z.discriminatedUnion("kind", [AiFeedbackReport, SandboxReport]);
/** An optional run report. */
export type OptionalRunReport = z.infer<typeof OptionalRunReport>;

/**
 * Why an optional run failed. `sandbox-unavailable` is the closed failure of a sandboxed run where
 * the district plan or the configured sandbox does not provide one. An AI run that governance or
 * policy refuses does not fail: it completes with `skipped` evidence.
 */
export const OptionalRunErrorCode = z.enum(["sandbox-unavailable", "sandbox-error", "model-unavailable", "integrity", "input-too-large", "retries-exhausted"]);
/** An optional run error code. */
export type OptionalRunErrorCode = z.infer<typeof OptionalRunErrorCode>;

/** A failed optional run's reason, for the teacher. */
export const OptionalRunError = z.strictObject({ code: OptionalRunErrorCode, message: z.string().min(1).max(1000) });
/** An optional run error. */
export type OptionalRunError = z.infer<typeof OptionalRunError>;

/**
 * One durable AI or sandboxed assessment run: separate from the submission's deterministic run,
 * keyed by the same `AssessmentRunKey` shape, with its execution profile naming an `ai` or
 * `sandbox` profile. Teacher-side data: its config may hold instructions or hidden test names.
 */
export const OptionalRun = z.strictObject({
  id: AssessmentRunId,
  key: AssessmentRunKey,
  spec: OptionalRunSpec,
  submissionId: SubmissionId,
  districtId: DistrictId,
  offeringId: OfferingId,
  activityId: ActivityId,
  requestedBy: PrincipalId,
  state: RunState,
  revision: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  lastAttemptError: z.string().max(1000).optional(),
  report: OptionalRunReport.optional(),
  error: OptionalRunError.optional(),
}).refine((r) => (r.state === "completed") === (r.report !== undefined) && (r.state === "failed") === (r.error !== undefined), "a completed run has a report and a failed run an error")
  .refine((r) => r.report === undefined || r.report.kind === r.spec.kind, "a run's report is of its own kind");
/** An optional run. */
export type OptionalRun = z.infer<typeof OptionalRun>;

/**
 * A teacher's decision on one criterion's AI feedback from one run: `accept` the suggestion,
 * `reject` it, or `edit` it to another level. Always with a reason, always the teacher acting
 * directly. Accepting posts the AI's level as a suggested score labelled with the model; editing
 * posts the teacher's level as their own criterion score. Neither is an official grade.
 */
export const OverrideDecision = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("accept") }),
  z.strictObject({ decision: z.literal("reject") }),
  z.strictObject({ decision: z.literal("edit"), levelId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }),
]);
/** An override decision. */
export type OverrideDecision = z.infer<typeof OverrideDecision>;

/** What recording an override takes. */
export const NewOverride = z.strictObject({
  runId: AssessmentRunId,
  criterionId: CriterionId,
  reason: z.string().trim().min(1).max(1000),
  override: OverrideDecision,
});
/** A new override. */
export type NewOverride = z.infer<typeof NewOverride>;

/** A recorded override. The latest for a run and criterion is the one in force. */
export const TeacherOverride = z.strictObject({
  submissionId: SubmissionId,
  runId: AssessmentRunId,
  criterionId: CriterionId,
  override: OverrideDecision,
  reason: z.string().min(1).max(1000),
  decidedBy: PrincipalId,
  decidedAt: z.iso.datetime(),
  channel: z.literal("http"),
});
/** A teacher override. */
export type TeacherOverride = z.infer<typeof TeacherOverride>;

/** A teacher's release of one AI run's feedback to the student, where the activity's policy allows it. */
export const AiRelease = z.strictObject({
  submissionId: SubmissionId,
  runId: AssessmentRunId,
  releasedBy: PrincipalId,
  releasedAt: z.iso.datetime(),
  channel: z.literal("http"),
});
/** An AI release. */
export type AiRelease = z.infer<typeof AiRelease>;

/** Everything about a submission's optional runs a report is built from. */
export interface OptionalRecords {
  runs: OptionalRun[];
  overrides: TeacherOverride[];
  releases: AiRelease[];
  /** The activity's AI-help policy now. */
  aiHelpPolicy: AiHelpPolicy;
}
