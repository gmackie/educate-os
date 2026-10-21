// AI and sandboxed assessment runs over submissions. Their durability (an optimistic revision per
// change, a lease on `running`, transient failures retried within the profile's limit) follows the
// deterministic engine in `@schoolos/assessment-ci` (SCHO-20), which they deliberately do not
// share: that engine's guarantees (zero cost, no clock, randomness or network) are exactly what
// these runs cannot give.
import { z } from "zod";
import { AssessmentRunId, compareUsdNano, SchoolOsError, SubmissionId, usdNano, usdNanoValue, type Caller, type UsdNano } from "@schoolos/contracts";
import { submissionDigest, type AssessmentService, type AssignmentBinding, type RubricReleaseRef, type SubmissionSnapshot } from "@schoolos/assessment";
import {
  assertRubricAuthority,
  assessmentRunIdFor,
  canonicalDigest,
  ExecutionProfileId,
  IdempotencyKey,
  verifyRubricRelease,
  type AssessmentReport,
  type AssessmentRunKey,
  type AssessmentRuns,
  type EvaluationArtifact,
  type RubricRelease,
  type RubricReleaseStore,
  type RubricSigningPolicy,
  type SubmittedWork,
} from "@schoolos/assessment-ci";
import { canonicalTextBytes, isTextMediaType, sha256Digest } from "@schoolos/learning-artifacts";
import { AiFeedbackConfig, type AiFeedbackEvaluator, type AiOutcome } from "./ai-feedback.ts";
import { modelLabel } from "./model-port.ts";
import {
  AiRelease,
  NewOverride,
  type OptionalRecords,
  type OptionalRun,
  type OptionalRunError,
  type OptionalRunReport,
  type OptionalRunSpec,
  type SandboxCheckResult,
  type TeacherOverride,
} from "./model.ts";
import type { AiExecutionProfile, AiHelpPolicySource, DistrictAssessmentPlan, OptionalExecutionProfile, SandboxExecutionProfile } from "./profiles.ts";
import { SANDBOX_EVALUATOR, SandboxCheck, SandboxResult, sandboxEvidence, sandboxFiles, unavailableSandbox, type ExecutionSandbox } from "./sandbox.ts";
import type { OptionalRunStore } from "./store.ts";
import { aiSuggestedLevel, studentReportView, teacherReportView, type StudentReportView, type TeacherReportView } from "./views.ts";

/** What requesting AI feedback on a submission takes. */
export const AiRunRequest = z.strictObject({
  submissionId: SubmissionId,
  idempotencyKey: IdempotencyKey,
  /** An `ai` profile, which names the model. */
  executionProfile: ExecutionProfileId,
  config: AiFeedbackConfig.default({}),
});
/** An AI run request. */
export type AiRunRequest = z.input<typeof AiRunRequest>;

/** What running executable checks on a submission takes. */
export const SandboxRunRequest = z.strictObject({
  submissionId: SubmissionId,
  idempotencyKey: IdempotencyKey,
  /** A `sandbox` profile. */
  executionProfile: ExecutionProfileId,
  checks: z.array(SandboxCheck).min(1).max(20),
});
/** A sandbox run request. */
export type SandboxRunRequest = z.input<typeof SandboxRunRequest>;

/** What an {@link AssessmentAi} is built from. */
export interface AssessmentAiOptions {
  /** Every submission read and feedback write goes through it, and its policy checks. */
  assessment: AssessmentService;
  rubrics: RubricReleaseStore;
  /** The deterministic runs, whose reports the views merge. */
  deterministicRuns: AssessmentRuns;
  store: OptionalRunStore;
  /** The `ai` and `sandbox` profiles runs may name. */
  profiles: readonly OptionalExecutionProfile[];
  /** The AI feedback evaluator. Without one, AI feedback is `unavailable`. */
  ai?: AiFeedbackEvaluator;
  /** The execution sandbox. Defaults to {@link unavailableSandbox}. */
  sandbox?: ExecutionSandbox;
  /** What the district's plan includes. A sandboxed run where the plan has no sandbox fails closed. */
  plan: DistrictAssessmentPlan;
  aiHelpPolicies: AiHelpPolicySource;
  /**
   * Who may sign rubric releases. With it, every run checks when it executes that its release is
   * bound to the submission's offering and that the signer still teaches it, as deterministic runs
   * do (`assertRubricAuthority`); without it, only the offering of a bound release is checked.
   */
  signing?: RubricSigningPolicy;
  /** How long a `running` run is left to its worker before another may reclaim it. Defaults to five minutes. */
  leaseMs?: number;
  now?: () => Date;
}

type Outcome = { kind: "completed"; report: OptionalRunReport } | { kind: "failed"; error: OptionalRunError } | { kind: "retry"; message: string };

function failed(code: OptionalRunError["code"], message: string): Extract<Outcome, { kind: "failed" }> {
  return { kind: "failed", error: { code, message: message.slice(0, 1000) } };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

/** A submission the caller may review, with its assignment. */
interface Reviewed {
  submission: SubmissionSnapshot;
  assignment: AssignmentBinding;
}

/**
 * Optional Assessment CI (roadmap E03): AI feedback and executable checks, each a separate run on
 * a submission beside its deterministic run, and the teacher's overrides and releases of AI
 * feedback.
 *
 * - Only a teacher of the offering acting directly in SchoolOS configures and starts these runs,
 *   overrides AI feedback, or releases it: an agent or tool may read them, never decide them.
 * - AI runs are reserved with governance under the run's ID, so retrying a run never bills twice,
 *   and a denial leaves `skipped` evidence rather than an error. Their findings are labelled
 *   `ai-suggested` and reach feedback only through a teacher's override: accepting posts a
 *   suggested score, editing posts the teacher's own; an official grade still needs the
 *   assessment service's approval gate.
 * - Sandboxed runs execute only where the district plan and the configured sandbox provide one,
 *   and fail closed everywhere else.
 */
export class AssessmentAi {
  readonly #options: AssessmentAiOptions;
  readonly #profiles: ReadonlyMap<string, OptionalExecutionProfile>;
  readonly #sandbox: ExecutionSandbox;
  readonly #leaseMs: number;
  readonly #now: () => Date;

  constructor(options: AssessmentAiOptions) {
    this.#options = options;
    this.#profiles = new Map(options.profiles.map((p) => [p.id, p]));
    this.#sandbox = options.sandbox ?? unavailableSandbox();
    this.#leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  /** Requests and executes AI feedback on a submission, or returns the run already stored for the same key. */
  async requestAiFeedback(caller: Caller, rawRequest: AiRunRequest): Promise<OptionalRun> {
    const request = parse(AiRunRequest, rawRequest);
    const ai = this.#options.ai;
    if (ai === undefined) throw new SchoolOsError("unavailable", "AI feedback is not configured for this district.");
    const profile = this.#profile(request.executionProfile, "ai");
    const reviewed = await this.#asTeacher(caller, request.submissionId);
    const rubric = await this.#rubricOf(reviewed.submission);
    for (const id of request.config.criteria ?? []) {
      if (!rubric.criteria.some((c) => c.id === id)) throw new SchoolOsError("validation-failed", `The rubric has no criterion ${id}.`);
    }
    if (rubric.aiInstructions !== undefined && request.config.instructions !== undefined) {
      throw new SchoolOsError("validation-failed", "This rubric's release carries the signed AI instructions; they cannot be replaced for one run.");
    }
    const spec: OptionalRunSpec = { kind: "ai", evaluator: { id: ai.id, release: ai.release }, model: profile.model, config: request.config };
    return this.#requestAndExecute(caller, reviewed, rubric, spec, request);
  }

  /** Requests and executes a teacher's executable checks on a submission, failing closed without a sandbox. */
  async runSandbox(caller: Caller, rawRequest: SandboxRunRequest): Promise<OptionalRun> {
    const request = parse(SandboxRunRequest, rawRequest);
    this.#profile(request.executionProfile, "sandbox");
    const reviewed = await this.#asTeacher(caller, request.submissionId);
    const rubric = await this.#rubricOf(reviewed.submission);
    if (new Set(request.checks.map((c) => c.id)).size !== request.checks.length) throw new SchoolOsError("validation-failed", "Check IDs are unique.");
    for (const check of request.checks) {
      if (!rubric.criteria.some((c) => c.id === check.criterionId)) throw new SchoolOsError("validation-failed", `The rubric has no criterion ${check.criterionId}.`);
    }
    const spec: OptionalRunSpec = { kind: "sandbox", evaluator: { ...SANDBOX_EVALUATOR }, checks: request.checks };
    return this.#requestAndExecute(caller, reviewed, rubric, spec, request);
  }

  /** One optional run on a submission, for its reviewers. */
  async getRun(caller: Caller, rawSubmissionId: SubmissionId, rawRunId: AssessmentRunId): Promise<OptionalRun> {
    const { submission } = await this.#asReviewer(caller, parse(SubmissionId, rawSubmissionId));
    return this.#runOn(submission, parse(AssessmentRunId, rawRunId));
  }

  /**
   * Records a teacher's decision on one criterion's AI feedback (see {@link TeacherOverride}) and
   * carries it into the submission's feedback: an accepted level as a suggested score labelled
   * with the model, an edited level as the teacher's own score. Neither is an official grade.
   */
  async override(caller: Caller, rawSubmissionId: SubmissionId, rawInput: NewOverride): Promise<TeacherOverride> {
    const input = parse(NewOverride, rawInput);
    const { submission } = await this.#asTeacher(caller, parse(SubmissionId, rawSubmissionId));
    const run = await this.#runOn(submission, input.runId);
    const report = run.report;
    if (report?.kind !== "ai" || report.outcome.status !== "completed") throw new SchoolOsError("conflict", "This run has no AI feedback to decide on.");
    const findings = report.outcome.findings.filter((f) => f.criterionId === input.criterionId);
    if (findings.length === 0) throw new SchoolOsError("validation-failed", `This run has no AI feedback on criterion ${input.criterionId}.`);
    const criterion = (await this.#rubricOf(submission)).criteria.find((c) => c.id === input.criterionId)!;
    const maxPoints = criterion.levels.at(-1)!.points;

    if (input.override.decision === "accept") {
      const level = aiSuggestedLevel(criterion, findings);
      if (level !== undefined && maxPoints > 0) {
        await this.#options.assessment.scoreCriterion(caller, submission.id, {
          criterionId: criterion.id,
          points: level.points,
          maxPoints,
          suggestedBy: { kind: "ai", modelId: modelLabel(report.model) },
        });
      }
    } else if (input.override.decision === "edit") {
      const levelId = input.override.levelId;
      const level = criterion.levels.find((l) => l.id === levelId);
      if (level === undefined) throw new SchoolOsError("validation-failed", `Criterion ${criterion.id} has no level ${levelId}.`);
      await this.#options.assessment.scoreCriterion(caller, submission.id, { criterionId: criterion.id, points: level.points, ...(maxPoints > 0 ? { maxPoints } : {}) });
    }
    const recorded: TeacherOverride = {
      submissionId: submission.id,
      runId: run.id,
      criterionId: criterion.id,
      override: input.override,
      reason: input.reason,
      decidedBy: caller.principal.principalId,
      decidedAt: this.#now().toISOString(),
      channel: "http",
    };
    await this.#options.store.addOverride(recorded);
    return recorded;
  }

  /** Releases one AI run's feedback to the student, where the activity's AI-help policy is `releasable`. Idempotent. */
  async release(caller: Caller, rawSubmissionId: SubmissionId, rawRunId: AssessmentRunId): Promise<AiRelease> {
    const { submission, assignment } = await this.#asTeacher(caller, parse(SubmissionId, rawSubmissionId));
    const run = await this.#runOn(submission, parse(AssessmentRunId, rawRunId));
    if (run.report?.kind !== "ai" || run.report.outcome.status !== "completed") throw new SchoolOsError("conflict", "This run has no AI feedback to release.");
    if ((await this.#aiHelpPolicy(assignment)) !== "releasable") {
      throw new SchoolOsError("policy-violation", "This activity's AI-help policy does not allow AI feedback to be released to students.");
    }
    const existing = (await this.#options.store.releasesFor(submission.id)).find((r) => r.runId === run.id);
    if (existing !== undefined) return existing;
    const release: AiRelease = { submissionId: submission.id, runId: run.id, releasedBy: caller.principal.principalId, releasedAt: this.#now().toISOString(), channel: "http" };
    await this.#options.store.addRelease(release);
    return release;
  }

  /** The teacher's report on a submission: every source of evidence, merged, with override actions. */
  async teacherReport(caller: Caller, rawSubmissionId: SubmissionId, deterministicRunId?: AssessmentRunId): Promise<TeacherReportView> {
    const reviewed = await this.#asReviewer(caller, parse(SubmissionId, rawSubmissionId));
    return teacherReportView(await this.#reportInputs(reviewed, deterministicRunId));
  }

  /**
   * The student's report on their submission: student-visible checks and the AI feedback their
   * teacher released, and nothing else. Its reviewers may preview it.
   */
  async studentReport(caller: Caller, rawSubmissionId: SubmissionId, deterministicRunId?: AssessmentRunId): Promise<StudentReportView> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const submission = await this.#options.assessment.getSubmission(caller, submissionId);
    const reviewed = submission.studentPrincipalId === caller.principal.principalId
      ? { submission, assignment: (await this.#options.assessment.getAssignment(caller, submission.assignmentId)).assignment }
      : await this.#asReviewer(caller, submissionId);
    return studentReportView(await this.#reportInputs(reviewed, deterministicRunId));
  }

  // Internals

  async #reportInputs(reviewed: Reviewed, deterministicRunId: AssessmentRunId | undefined) {
    const { submission, assignment } = reviewed;
    let deterministic: AssessmentReport | undefined;
    if (deterministicRunId !== undefined) {
      const run = await this.#options.deterministicRuns.get(parse(AssessmentRunId, deterministicRunId));
      if (run.key.submissionDigest !== submission.submissionDigest) throw new SchoolOsError("not-found", `Assessment run ${deterministicRunId} was not found.`);
      deterministic = run.report;
    }
    const records: OptionalRecords = {
      runs: await this.#options.store.runsFor(submission.id),
      overrides: await this.#options.store.overridesFor(submission.id),
      releases: await this.#options.store.releasesFor(submission.id),
      aiHelpPolicy: await this.#aiHelpPolicy(assignment),
    };
    return { submissionId: submission.id, rubric: await this.#rubricOf(submission), ...(deterministic === undefined ? {} : { deterministic }), ...records };
  }

  /** The submission, if the caller is one of its reviewers: never its student, and someone who may read its feedback. */
  async #asReviewer(caller: Caller, submissionId: SubmissionId): Promise<Reviewed> {
    const submission = await this.#options.assessment.getSubmission(caller, submissionId);
    if (submission.studentPrincipalId === caller.principal.principalId) {
      throw new SchoolOsError("forbidden", "Only the submission's teachers can do this.");
    }
    await this.#options.assessment.getFeedback(caller, submission.id);
    const { assignment } = await this.#options.assessment.getAssignment(caller, submission.assignmentId);
    return { submission, assignment };
  }

  /** {@link asReviewer}, acting directly in SchoolOS: what configuring a run or deciding on AI feedback needs. */
  async #asTeacher(caller: Caller, submissionId: SubmissionId): Promise<Reviewed> {
    if (caller.channel !== "http") throw new SchoolOsError("forbidden", "Only a teacher acting directly in SchoolOS can configure or decide on AI and sandboxed checks.");
    const reviewed = await this.#asReviewer(caller, submissionId);
    if (reviewed.submission.withdrawnAt !== undefined) throw new SchoolOsError("conflict", "This submission was withdrawn.");
    return reviewed;
  }

  async #aiHelpPolicy(assignment: AssignmentBinding) {
    return (await this.#options.aiHelpPolicies.aiHelpPolicy(assignment.activityId)) ?? "none";
  }

  async #rubricOf(submission: SubmissionSnapshot): Promise<RubricRelease> {
    if (submission.rubric === undefined) throw new SchoolOsError("validation-failed", "This submission has no rubric to assess against.");
    return this.#rubric(submission.rubric);
  }

  async #rubric(ref: RubricReleaseRef): Promise<RubricRelease> {
    const rubric = await this.#options.rubrics.get(ref);
    if (rubric === undefined) throw new SchoolOsError("not-found", `Rubric ${ref.rubricId} version ${ref.version} was not found.`);
    await verifyRubricRelease(rubric);
    return rubric;
  }

  async #runOn(submission: SubmissionSnapshot, runId: AssessmentRunId): Promise<OptionalRun> {
    const run = await this.#options.store.getRun(runId);
    if (run === undefined || run.submissionId !== submission.id) throw new SchoolOsError("not-found", `Assessment run ${runId} was not found.`);
    return run;
  }

  #profile<K extends OptionalExecutionProfile["kind"]>(id: string, kind: K): Extract<OptionalExecutionProfile, { kind: K }> {
    const profile = this.#profiles.get(id);
    if (profile?.kind !== kind) throw new SchoolOsError("validation-failed", `No ${kind} execution profile ${id} is available.`);
    return profile as Extract<OptionalExecutionProfile, { kind: K }>;
  }

  async #requestAndExecute(
    caller: Caller,
    { submission, assignment }: Reviewed,
    rubric: RubricRelease,
    spec: OptionalRunSpec,
    request: { idempotencyKey: string; executionProfile: string },
  ): Promise<OptionalRun> {
    const key: AssessmentRunKey = {
      submissionDigest: submission.submissionDigest,
      rubricRelease: { rubricId: rubric.rubricId, version: rubric.version },
      // The evaluator release and everything the teacher configured: a new config is a new run.
      evaluatorRelease: await canonicalDigest({ format: "schoolos.optional-evaluator.v1", spec }),
      executionProfile: request.executionProfile,
      idempotencyKey: request.idempotencyKey,
    };
    const run = await this.#options.store.insertRun({
      id: await assessmentRunIdFor(key),
      key,
      spec,
      submissionId: submission.id,
      districtId: submission.districtId,
      offeringId: submission.offeringId,
      activityId: assignment.activityId,
      requestedBy: caller.principal.principalId,
      state: "queued",
      revision: 0,
      attempts: 0,
      queuedAt: this.#now().toISOString(),
    });
    return this.#execute(run.id, this.#work(caller, submission));
  }

  /** Executes a queued run and returns it finished, as the deterministic engine does. */
  async #execute(id: AssessmentRunId, work: SubmittedWork): Promise<OptionalRun> {
    for (let guard = 0; guard < 100; guard++) {
      const run = await this.#options.store.getRun(id);
      if (run === undefined) throw new SchoolOsError("not-found", `Assessment run ${id} was not found.`);
      if (run.state === "completed" || run.state === "failed") return run;
      const profile = this.#profile(run.key.executionProfile, run.spec.kind);
      const now = this.#now();
      if (run.state === "running" && now.getTime() - Date.parse(run.startedAt ?? run.queuedAt) < this.#leaseMs) return run;

      const allowed = 1 + (profile.kind === "ai" ? profile.limits.maxRetries : profile.maxRetries);
      if (run.attempts >= allowed) {
        await this.#giveUp(run);
        await this.#finish(run, failed("retries-exhausted", run.lastAttemptError ?? `The run was attempted ${run.attempts} times without finishing.`));
        continue;
      }
      const claimed: OptionalRun = { ...run, state: "running", attempts: run.attempts + 1, startedAt: now.toISOString(), revision: run.revision + 1 };
      if (!(await this.#commit(claimed, run.revision))) continue;

      const outcome = await this.#attempt(claimed, profile, work);
      if (outcome.kind === "retry") {
        if (claimed.attempts >= allowed) {
          await this.#giveUp(claimed);
          await this.#finish(claimed, failed(claimed.spec.kind === "ai" ? "model-unavailable" : "retries-exhausted", `Gave up after ${claimed.attempts} attempts: ${outcome.message}`));
        } else {
          await this.#commit({ ...claimed, state: "queued", lastAttemptError: outcome.message.slice(0, 1000), revision: claimed.revision + 1 }, claimed.revision);
        }
        continue;
      }
      await this.#finish(claimed, outcome);
    }
    throw new SchoolOsError("conflict", `Assessment run ${id} kept changing while it was executed.`);
  }

  /** Releases an abandoned AI run's reservation, so a run that never got an answer is never charged. */
  async #giveUp(run: OptionalRun): Promise<void> {
    if (run.spec.kind === "ai") await this.#options.ai?.abandon(run.id);
  }

  async #finish(run: OptionalRun, outcome: Exclude<Outcome, { kind: "retry" }>): Promise<void> {
    const finishedAt = this.#now().toISOString();
    await this.#commit(
      outcome.kind === "completed"
        ? { ...run, state: "completed", report: outcome.report, finishedAt, revision: run.revision + 1 }
        : { ...run, state: "failed", error: outcome.error, finishedAt, revision: run.revision + 1 },
      run.revision,
    );
  }

  async #commit(next: OptionalRun, expectedRevision: number): Promise<boolean> {
    try {
      await this.#options.store.replaceRun(next, expectedRevision);
      return true;
    } catch (error) {
      if (error instanceof SchoolOsError && error.code === "conflict") return false;
      throw error;
    }
  }

  async #attempt(run: OptionalRun, profile: OptionalExecutionProfile, work: SubmittedWork): Promise<Outcome> {
    let rubric: RubricRelease;
    try {
      rubric = await this.#rubric(run.key.rubricRelease);
    } catch (error) {
      if (error instanceof SchoolOsError) return failed("integrity", error.message);
      throw error;
    }
    try {
      await assertRubricAuthority(rubric, work.offeringId, this.#options.signing);
    } catch (error) {
      if (error instanceof SchoolOsError) return failed("rubric-not-authorized", error.message);
      throw error;
    }
    const read = await readWork(work, run.key.submissionDigest);
    if ("kind" in read) return read;
    if (run.spec.kind === "ai" && profile.kind === "ai") return this.#attemptAi(run, run.spec, profile, rubric, read.artifacts);
    if (run.spec.kind === "sandbox" && profile.kind === "sandbox") return this.#attemptSandbox(run, run.spec, profile, read.artifacts);
    return failed("integrity", `Run ${run.id} names a profile of another kind.`);
  }

  async #attemptAi(
    run: OptionalRun,
    spec: Extract<OptionalRunSpec, { kind: "ai" }>,
    profile: AiExecutionProfile,
    rubric: RubricRelease,
    artifacts: EvaluationArtifact[],
  ): Promise<Outcome> {
    const completed = (outcome: AiOutcome, costUsdNano: UsdNano): Outcome => ({
      kind: "completed",
      report: { kind: "ai", format: "schoolos.ai-feedback-report.v2", runId: run.id, key: run.key, label: "ai-suggested", evaluator: spec.evaluator, model: spec.model, outcome, costUsdNano },
    });
    const ai = this.#options.ai;
    if (ai === undefined || ai.id !== spec.evaluator.id || ai.release !== spec.evaluator.release) {
      return failed("model-unavailable", `Evaluator ${spec.evaluator.id}@${spec.evaluator.release} is not available.`);
    }
    // The policy in force when the work is sent decides, not the one when the run was queued.
    const policy = (await this.#options.aiHelpPolicies.aiHelpPolicy(run.activityId)) ?? "none";
    if (policy === "none") return completed({ status: "skipped", reason: "ai-help-policy" }, "0");
    const criteria = rubric.criteria.filter((c) => spec.config.criteria === undefined || spec.config.criteria.includes(c.id));
    try {
      const evaluation = await ai.evaluate({
        requestId: run.id,
        governance: { principal: { principalId: run.requestedBy, districtId: run.districtId }, workspace: { kind: "course", offeringId: run.offeringId } },
        profile,
        criteria,
        artifacts,
      }, rubric.aiInstructions === undefined ? spec.config : { ...spec.config, instructions: rubric.aiInstructions });
      return completed(evaluation.outcome, evaluation.costUsdNano);
    } catch {
      return { kind: "retry", message: "The model request did not complete." };
    }
  }

  async #attemptSandbox(run: OptionalRun, spec: Extract<OptionalRunSpec, { kind: "sandbox" }>, profile: SandboxExecutionProfile, artifacts: EvaluationArtifact[]): Promise<Outcome> {
    if (this.#options.plan.sandbox !== "available") return failed("sandbox-unavailable", "This district's plan does not include the CI sandbox, so executable checks do not run.");
    const availability = this.#sandbox.availability();
    if (!availability.available) return failed("sandbox-unavailable", availability.reason);
    const files = sandboxFiles(artifacts);
    const checks: SandboxCheckResult[] = [];
    let spent = 0n;
    for (const check of spec.checks) {
      const remaining = usdNano(usdNanoValue(profile.sandbox.maxCostUsdNano) - spent);
      let raw: unknown;
      try {
        raw = await this.#sandbox.run({ jobId: `${run.id}:${check.id}`, entrypoint: check.entrypoint, files, profile: profile.sandbox, remainingCostUsdNano: remaining });
      } catch {
        return { kind: "retry", message: `The sandbox did not finish check ${check.id}.` };
      }
      const result = SandboxResult.safeParse(raw);
      if (!result.success) return failed("sandbox-error", `The sandbox returned a malformed result for check ${check.id}.`);
      if (result.data.status === "unavailable") return failed("sandbox-unavailable", result.data.reason);
      // The sandbox enforces the limits; a result beyond them means it did not, so nothing it said is kept.
      if (compareUsdNano(result.data.costUsdNano, remaining) > 0 || result.data.cpuMs > profile.sandbox.cpuMs) {
        return failed("sandbox-error", `The sandbox reported check ${check.id} beyond its profile's limits.`);
      }
      spent += usdNanoValue(result.data.costUsdNano);
      checks.push({
        checkId: check.id,
        criterionId: check.criterionId,
        visibility: check.visibility,
        ...(result.data.status === "limit-exceeded" ? { limit: result.data.limit } : {}),
        evidence: sandboxEvidence(check, result.data),
      });
    }
    return { kind: "completed", report: { kind: "sandbox", format: "schoolos.sandbox-report.v2", runId: run.id, key: run.key, evaluator: spec.evaluator, checks, costUsdNano: usdNano(spent) } };
  }

  #work(caller: Caller, submission: SubmissionSnapshot): SubmittedWork {
    return {
      items: submission.items,
      offeringId: submission.offeringId,
      readText: async (item) => {
        const { content } = await this.#options.assessment.readSubmittedContent(caller, submission.id, item.artifactId);
        if (content.kind !== "text") throw new SchoolOsError("unavailable", `Artifact ${item.artifactId} is not text.`);
        return content.text;
      },
    };
  }
}

/** Reads and verifies the submitted text, as the deterministic engine does. */
async function readWork(work: SubmittedWork, expected: string): Promise<{ artifacts: EvaluationArtifact[] } | Extract<Outcome, { kind: "failed" | "retry" }>> {
  if ((await submissionDigest(work.items)) !== expected) return failed("integrity", "The work supplied is not the submission this run assesses.");
  const artifacts: EvaluationArtifact[] = [];
  for (const item of work.items) {
    if (!isTextMediaType(item.mediaType)) continue;
    let text: string;
    try {
      text = await work.readText(item);
    } catch (error) {
      return { kind: "retry", message: error instanceof SchoolOsError ? error.message : `Artifact ${item.artifactId} could not be read.` };
    }
    if ((await sha256Digest(canonicalTextBytes(text))) !== item.digest) return failed("integrity", `Artifact ${item.artifactId} does not match the digest it was submitted with.`);
    artifacts.push({ artifactId: item.artifactId, revisionId: item.revisionId, digest: item.digest, artifactType: item.artifactType, mediaType: item.mediaType, text });
  }
  return { artifacts };
}
