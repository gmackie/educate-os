// Durable assessment runs. Isolating each evaluator so that one failure is recorded rather than
// crashing the caller follows PlayTrek's Hall Monitor baseline runner,
// `packages/ai/src/hallMonitor/baseline/runner.ts` at commit 7258e4347. Unlike that runner, a
// failing check fails the whole run with a stated reason, because a report missing a check would
// read as evidence that was never gathered.
import { z } from "zod";
import { AssessmentRunId, ContentDigest, SchoolOsError, type OfferingId } from "@schoolos/contracts";
import { RubricReleaseRef, submissionDigest, type SubmissionItem } from "@schoolos/assessment";
import { canonicalTextBytes, isTextMediaType, sha256Digest } from "@schoolos/learning-artifacts";
import { canonicalDigest } from "./canonical.ts";
import { deepFreeze, runDeterministically } from "./determinism.ts";
import {
  AssessmentRun,
  DETERMINISTIC_PROFILE,
  ExecutionProfileId,
  IdempotencyKey,
  type AssessmentReport,
  type AssessmentRunKey,
  type CheckResult,
  type CriterionReport,
  type CriterionSuggestion,
  type ExecutionProfile,
  type ReportSummary,
  type RunError,
  type StudentAssessmentReport,
} from "./model.ts";
import type { EvaluatorRegistry } from "./registry.ts";
import { assertRubricAuthority, verifyRubricRelease, type RubricCriterion, type RubricRelease, type RubricReleaseStore, type RubricSigningPolicy } from "./rubric.ts";
import { CriterionEvidence, StepBudgetExceeded, StepMeter, evaluatorLabel, type EvaluationArtifact, type EvaluationKit, type EvaluatorRelease } from "./sdk.ts";
import type { AssessmentRunStore } from "./store.ts";

/** What requesting a run takes: everything in its key but the evaluator releases, which the registry resolves. */
export const RunRequest = z.strictObject({
  submissionDigest: ContentDigest,
  rubricRelease: RubricReleaseRef,
  executionProfile: ExecutionProfileId,
  idempotencyKey: IdempotencyKey,
});
/** A run request. */
export type RunRequest = z.infer<typeof RunRequest>;

/** The submitted work a run reads: the submission's items, and a way to read each text item's content. */
export interface SubmittedWork {
  readonly items: readonly SubmissionItem[];
  /**
   * The offering the work was done in. A rubric release bound to an offering assesses only that
   * offering's work, so it fails a run whose work names no offering or another one.
   */
  readonly offeringId?: OfferingId;
  /** The canonical text of one item. A failure here is treated as transient and retried. */
  readText(item: SubmissionItem): Promise<string>;
}

/** What an {@link AssessmentRuns} is built from. */
export interface AssessmentRunsOptions {
  runs: AssessmentRunStore;
  rubrics: RubricReleaseStore;
  registry: EvaluatorRegistry;
  /**
   * Who may sign rubric releases. With it, every run checks when it executes that its release is
   * bound to the work's offering and that the signer still teaches it (see
   * `assertRubricAuthority`); without it, only the offering of a bound release is checked.
   */
  signing?: RubricSigningPolicy;
  /** The profiles runs may name. Defaults to {@link DETERMINISTIC_PROFILE}. */
  profiles?: readonly ExecutionProfile[];
  /** How long a `running` run is left to its worker before another may reclaim it. Defaults to five minutes. */
  leaseMs?: number;
  /** The clock, for the run's own timestamps only; evaluators never see it. Defaults to the system clock. */
  now?: () => Date;
}

/** The digest a run key's `evaluatorRelease` holds: of the exact releases, sorted by ID. */
export async function evaluatorSetDigest(releases: readonly EvaluatorRelease[]): Promise<ContentDigest> {
  return canonicalDigest({ format: "schoolos.evaluator-set.v1", releases });
}

/** The run ID a key names: derived from the key, so requesting the same key always finds the same run. */
export async function assessmentRunIdFor(key: AssessmentRunKey): Promise<AssessmentRunId> {
  const digest = await canonicalDigest({ format: "schoolos.assessment-run-key.v1", key });
  return AssessmentRunId.parse(`asr_${digest.slice("sha256:".length, "sha256:".length + 40)}`);
}

/** What one execution attempt came to. */
type Outcome =
  | { kind: "completed"; report: AssessmentReport }
  | { kind: "failed"; error: RunError }
  | { kind: "retry"; message: string };

function failed(code: RunError["code"], message: string): Extract<Outcome, { kind: "failed" }> {
  return { kind: "failed", error: { code, message: message.slice(0, 1000) } };
}

/** A check's failure, which fails the run. */
function checkError(code: RunError["code"], message: string): { error: RunError } {
  return { error: { code, message: message.slice(0, 1000) } };
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Queues and executes assessment runs (roadmap §7). A run is keyed by `(submissionDigest,
 * rubricRelease, evaluatorRelease, executionProfile, idempotencyKey)` and is idempotent on it:
 * requesting a key again returns the same run, finished or not, and a new rubric or evaluator
 * release is a new key and so a new run.
 *
 * Execution is durable: each state change is committed before the next step, a run interrupted
 * mid-execution is reclaimed after its lease, and a transient failure (the work could not be read)
 * is retried within the profile's limit. Evaluation itself is deterministic, so any failure of an
 * evaluator is final.
 */
export class AssessmentRuns {
  readonly #runs: AssessmentRunStore;
  readonly #rubrics: RubricReleaseStore;
  readonly #registry: EvaluatorRegistry;
  readonly #signing: RubricSigningPolicy | undefined;
  readonly #profiles: ReadonlyMap<string, ExecutionProfile>;
  readonly #leaseMs: number;
  readonly #now: () => Date;

  constructor(options: AssessmentRunsOptions) {
    this.#runs = options.runs;
    this.#rubrics = options.rubrics;
    this.#registry = options.registry;
    this.#signing = options.signing;
    this.#profiles = new Map((options.profiles ?? [DETERMINISTIC_PROFILE]).map((p) => [p.id, p]));
    this.#leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.#now = options.now ?? (() => new Date());
  }

  /** The run, or `not-found`. */
  async get(id: AssessmentRunId): Promise<AssessmentRun> {
    const run = await this.#runs.get(id);
    if (run === undefined) throw new SchoolOsError("not-found", `Assessment run ${id} was not found.`);
    return run;
  }

  /**
   * Queues the run `request` names, resolving each check's evaluator to the release the registry
   * pins, or returns the run already stored for the same key.
   */
  async request(rawRequest: RunRequest): Promise<AssessmentRun> {
    const parsed = RunRequest.safeParse(rawRequest);
    if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
    const request = parsed.data;
    this.#profile(request.executionProfile);
    const rubric = await this.#rubric(request.rubricRelease);
    const pinned = new Map<string, EvaluatorRelease>();
    for (const check of rubric.criteria.flatMap((c) => c.checks)) {
      const { id, release } = this.#registry.pinned(check.evaluatorId);
      pinned.set(id, { id, release });
    }
    const evaluators = [...pinned.values()].toSorted(byId);
    const key: AssessmentRunKey = {
      submissionDigest: request.submissionDigest,
      rubricRelease: request.rubricRelease,
      evaluatorRelease: await evaluatorSetDigest(evaluators),
      executionProfile: request.executionProfile,
      idempotencyKey: request.idempotencyKey,
    };
    return this.#runs.insert({
      id: await assessmentRunIdFor(key),
      key,
      evaluators,
      state: "queued",
      revision: 0,
      attempts: 0,
      queuedAt: this.#now().toISOString(),
    });
  }

  /**
   * Executes a queued run against `work` and returns it finished. A finished run is returned as
   * it is, without executing again; a run another worker holds within its lease is returned
   * `running`.
   */
  async execute(id: AssessmentRunId, work: SubmittedWork): Promise<AssessmentRun> {
    for (let guard = 0; guard < 100; guard++) {
      const run = await this.get(id);
      if (run.state === "completed" || run.state === "failed") return run;
      const profile = this.#profile(run.key.executionProfile);
      const now = this.#now();
      if (run.state === "running" && now.getTime() - Date.parse(run.startedAt ?? run.queuedAt) < this.#leaseMs) return run;

      const allowed = 1 + profile.limits.maxRetries;
      if (run.attempts >= allowed) {
        // Only an attempt that never reported back leaves the run here.
        await this.#finish(run, failed("retries-exhausted", run.lastAttemptError ?? `The run was attempted ${run.attempts} times without finishing.`));
        continue;
      }
      const claimed: AssessmentRun = { ...run, state: "running", attempts: run.attempts + 1, startedAt: now.toISOString(), revision: run.revision + 1 };
      if (!(await this.#commit(claimed, run.revision))) continue;

      const outcome = await this.#attempt(claimed, profile, work);
      if (outcome.kind === "retry") {
        if (claimed.attempts >= allowed) {
          await this.#finish(claimed, failed("retries-exhausted", `The submitted work could not be read after ${claimed.attempts} attempts: ${outcome.message}`));
        } else {
          await this.#commit({ ...claimed, state: "queued", lastAttemptError: outcome.message.slice(0, 1000), revision: claimed.revision + 1 }, claimed.revision);
        }
        continue;
      }
      await this.#finish(claimed, outcome);
    }
    throw new SchoolOsError("conflict", `Assessment run ${id} kept changing while it was executed.`);
  }

  /**
   * Works through the queue: executes up to `limit` runs that are queued, or whose worker's lease
   * expired, against the work `workFor` finds for each, and returns them as they ended up. A run
   * whose work cannot be found now is left queued for a later pass.
   */
  async drain(workFor: (run: AssessmentRun) => Promise<SubmittedWork | undefined>, limit = 20): Promise<AssessmentRun[]> {
    const due = await this.#runs.runnable(new Date(this.#now().getTime() - this.#leaseMs), limit);
    const results: AssessmentRun[] = [];
    for (const run of due) {
      const work = await workFor(run);
      if (work !== undefined) results.push(await this.execute(run.id, work));
    }
    return results;
  }

  #profile(id: string): ExecutionProfile {
    const profile = this.#profiles.get(id);
    if (profile === undefined) throw new SchoolOsError("validation-failed", `No execution profile ${id} is available.`);
    return profile;
  }

  async #rubric(ref: RubricReleaseRef): Promise<RubricRelease> {
    const rubric = await this.#rubrics.get(ref);
    if (rubric === undefined) throw new SchoolOsError("not-found", `Rubric ${ref.rubricId} version ${ref.version} was not found.`);
    await verifyRubricRelease(rubric);
    return rubric;
  }

  async #finish(run: AssessmentRun, outcome: Exclude<Outcome, { kind: "retry" }>): Promise<void> {
    const finishedAt = this.#now().toISOString();
    await this.#commit(
      outcome.kind === "completed"
        ? { ...run, state: "completed", report: outcome.report, finishedAt, revision: run.revision + 1 }
        : { ...run, state: "failed", error: outcome.error, finishedAt, revision: run.revision + 1 },
      run.revision,
    );
  }

  /** Commits `next`, answering whether it won; a concurrent change means the caller should re-read. */
  async #commit(next: AssessmentRun, expectedRevision: number): Promise<boolean> {
    try {
      await this.#runs.replace(next, expectedRevision);
      return true;
    } catch (error) {
      if (error instanceof SchoolOsError && error.code === "conflict") return false;
      throw error;
    }
  }

  /** One execution attempt: read and verify the work, then evaluate every check. */
  async #attempt(run: AssessmentRun, profile: ExecutionProfile, work: SubmittedWork): Promise<Outcome> {
    let rubric: RubricRelease;
    try {
      rubric = await this.#rubric(run.key.rubricRelease);
    } catch (error) {
      if (error instanceof SchoolOsError) return failed("integrity", error.message);
      throw error;
    }
    try {
      await assertRubricAuthority(rubric, work.offeringId, this.#signing);
    } catch (error) {
      if (error instanceof SchoolOsError) return failed("rubric-not-authorized", error.message);
      throw error;
    }

    const size = work.items.reduce((total, item) => total + item.sizeBytes, 0);
    if (size > profile.limits.maxInputBytes) {
      return failed("input-too-large", `The submitted work is ${size} bytes; this profile reads at most ${profile.limits.maxInputBytes}.`);
    }
    if ((await submissionDigest(work.items)) !== run.key.submissionDigest) {
      return failed("integrity", "The work supplied is not the submission this run assesses.");
    }

    const artifacts: EvaluationArtifact[] = [];
    for (const item of work.items) {
      if (!isTextMediaType(item.mediaType)) continue;
      let text: string;
      try {
        text = await work.readText(item);
      } catch (error) {
        return { kind: "retry", message: error instanceof SchoolOsError ? error.message : `Artifact ${item.artifactId} could not be read.` };
      }
      if ((await sha256Digest(canonicalTextBytes(text))) !== item.digest) {
        return failed("integrity", `Artifact ${item.artifactId} does not match the digest it was submitted with.`);
      }
      artifacts.push({ artifactId: item.artifactId, revisionId: item.revisionId, digest: item.digest, artifactType: item.artifactType, mediaType: item.mediaType, text });
    }
    deepFreeze(artifacts);

    const releases = new Map(run.evaluators.map((e) => [e.id, e]));
    const meter = new StepMeter(profile.limits.maxSteps);
    const kit: EvaluationKit = Object.freeze({ step: (units?: number) => meter.step(units) });
    const criteria: { criterion: RubricCriterion; checks: CheckResult[] }[] = [];
    for (const criterion of rubric.criteria) {
      const checks: CheckResult[] = [];
      for (const check of criterion.checks) {
        const release = releases.get(check.evaluatorId);
        if (release === undefined) return failed("integrity", `Check ${check.id} names evaluator ${check.evaluatorId}, which this run did not resolve.`);
        const result = this.#check(criterion, check, release, artifacts, kit, meter);
        if ("error" in result) return { kind: "failed", error: result.error };
        checks.push({ checkId: check.id, evaluator: release, visibility: check.visibility, evidence: result.evidence });
      }
      criteria.push({ criterion, checks });
    }
    return { kind: "completed", report: buildReport(run, rubric, criteria, meter.used) };
  }

  /** Evaluates one check in isolation: its config parsed and frozen, its evaluator guarded and metered, its output validated. */
  #check(
    criterion: RubricCriterion,
    check: RubricCriterion["checks"][number],
    release: EvaluatorRelease,
    artifacts: readonly EvaluationArtifact[],
    kit: EvaluationKit,
    meter: StepMeter,
  ): { evidence: CriterionEvidence[] } | { error: RunError } {
    const label = evaluatorLabel(release);
    let evaluator;
    try {
      evaluator = this.#registry.get(release);
    } catch (e) {
      if (e instanceof SchoolOsError) return checkError("evaluator-unavailable", e.message);
      throw e;
    }
    const config = evaluator.config.safeParse(check.config);
    if (!config.success) return checkError("invalid-config", `Check ${check.id} has a config ${label} does not accept: ${z.prettifyError(config.error)}`);

    const accepted = artifacts.filter((a) => evaluator.accepts.artifactTypes.includes(a.artifactType) && evaluator.accepts.mediaTypes.includes(a.mediaType));
    if (accepted.length === 0) {
      return {
        evidence: [{
          criterionId: criterion.id,
          observation: "No work this check can read",
          passed: false,
          excerpts: [],
          explanation: `This check reads ${evaluator.accepts.artifactTypes.join(" or ")} work as ${evaluator.accepts.mediaTypes.join(" or ")}, and the submission has none.`,
        }],
      };
    }
    const input = deepFreeze({ criterionId: criterion.id, artifacts: accepted });
    const frozenConfig = deepFreeze(config.data);

    let guarded;
    try {
      guarded = runDeterministically(() => evaluator.evaluate(input, frozenConfig, kit));
    } catch (e) {
      if (e instanceof StepBudgetExceeded || meter.exceeded) return checkError("step-budget-exceeded", `${e instanceof Error ? e.message : "The step budget was exceeded."} It ran out in check ${check.id} (${label}).`);
      return checkError("evaluator-error", `Check ${check.id} (${label}) failed: ${e instanceof Error ? e.message : "it threw a non-error value"}`);
    }
    if (meter.exceeded) return checkError("step-budget-exceeded", `The run used more than its step budget in check ${check.id} (${label}).`);
    if (guarded.violated) return checkError("nondeterministic-evaluator", `Check ${check.id} (${label}): ${guarded.error.message}`);

    const evidence = z.array(CriterionEvidence).max(500).safeParse(guarded.result);
    if (!evidence.success) return checkError("evaluator-error", `Check ${check.id} (${label}) returned malformed evidence: ${z.prettifyError(evidence.error)}`);
    for (const item of evidence.data) {
      if (item.criterionId !== criterion.id) return checkError("evaluator-error", `Check ${check.id} (${label}) returned evidence for another criterion.`);
      for (const excerpt of item.excerpts) {
        const artifact = accepted.find((a) => a.artifactId === excerpt.artifact && a.revisionId === excerpt.revision);
        if (artifact === undefined || excerpt.range.end > artifact.text.length) {
          return checkError("evaluator-error", `Check ${check.id} (${label}) cited text outside the work it was given.`);
        }
      }
    }
    return { evidence: evidence.data };
  }
}

/** Suggestions for one criterion: one per evaluator with judged evidence, snapped to the criterion's levels. */
function suggestionsFor(criterion: RubricCriterion, checks: readonly CheckResult[]): CriterionSuggestion[] {
  const maxPoints = criterion.levels.at(-1)!.points;
  if (maxPoints === 0) return [];
  const byEvaluator = new Map<string, { evaluator: EvaluatorRelease; scores: number[] }>();
  for (const check of checks) {
    const label = evaluatorLabel(check.evaluator);
    const entry = byEvaluator.get(label) ?? { evaluator: check.evaluator, scores: [] };
    for (const e of check.evidence) {
      if (e.score !== undefined) entry.scores.push(e.score);
      else if (e.passed !== undefined) entry.scores.push(e.passed ? 1 : 0);
    }
    byEvaluator.set(label, entry);
  }
  const suggestions: CriterionSuggestion[] = [];
  for (const { evaluator, scores } of byEvaluator.values()) {
    if (scores.length === 0) continue;
    const target = (scores.reduce((a, b) => a + b, 0) / scores.length) * maxPoints;
    const level = criterion.levels.findLast((l) => l.points <= target + 1e-9) ?? criterion.levels[0]!;
    suggestions.push({ evaluator, levelId: level.id, points: level.points, maxPoints });
  }
  return suggestions;
}

function summarize(criteria: readonly { checks: readonly CheckResult[] }[]): ReportSummary {
  const evidence = criteria.flatMap((c) => c.checks.flatMap((k) => k.evidence));
  const passed = evidence.filter((e) => e.passed === true).length;
  const failedCount = evidence.filter((e) => e.passed === false).length;
  const observations = evidence.length - passed - failedCount;
  const checks = criteria.reduce((n, c) => n + c.checks.length, 0);
  return {
    criteria: criteria.length,
    checks,
    passed,
    failed: failedCount,
    observations,
    text: `${passed} of ${passed + failedCount} findings passed across ${checks} check${checks === 1 ? "" : "s"} on ${criteria.length} criteri${criteria.length === 1 ? "on" : "a"}${observations === 0 ? "" : `, with ${observations} observation${observations === 1 ? "" : "s"}`}.`,
  };
}

/**
 * Rubric evidence collection: gathers each criterion's check evidence, suggests a level per
 * evaluator from it, and summarizes the whole.
 */
function buildReport(
  run: AssessmentRun,
  rubric: RubricRelease,
  results: readonly { criterion: RubricCriterion; checks: CheckResult[] }[],
  stepsUsed: number,
): AssessmentReport {
  const criteria: CriterionReport[] = results.map(({ criterion, checks }) => ({
    criterionId: criterion.id,
    title: criterion.title,
    checks,
    suggestions: suggestionsFor(criterion, checks),
  }));
  return {
    format: "schoolos.assessment-report.v2",
    runId: run.id,
    key: run.key,
    rubricDigest: rubric.signature.digest,
    criteria,
    summary: summarize(criteria),
    evaluatorReleases: run.evaluators,
    stepsUsed,
    costUsdNano: "0",
  };
}

/** The part of `report` its student may see: student-visible checks only, and no suggested scores. */
export function studentReport(report: AssessmentReport): StudentAssessmentReport {
  const criteria = report.criteria
    .map((c) => ({ criterionId: c.criterionId, title: c.title, checks: c.checks.filter((k) => k.visibility === "student-visible") }))
    .filter((c) => c.checks.length > 0);
  return {
    format: "schoolos.assessment-report.student.v1",
    runId: report.runId,
    rubric: report.key.rubricRelease,
    criteria,
    summary: summarize(criteria),
  };
}
