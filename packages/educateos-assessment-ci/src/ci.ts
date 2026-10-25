import { z } from "zod";
import { AssessmentRunId, EducateOsError, SubmissionId, type Caller } from "@educateos/contracts";
import { RubricReleaseRef, type AssessmentService, type CriterionScore, type SubmissionSnapshot } from "@educateos/assessment";
import { DETERMINISTIC_PROFILE, ExecutionProfileId, IdempotencyKey, type AssessmentReport, type AssessmentRun, type RunError, type RunState, type StudentAssessmentReport } from "./model.ts";
import { studentReport, type AssessmentRuns, type SubmittedWork } from "./runs.ts";
import { evaluatorLabel } from "./sdk.ts";

/** What running Assessment CI on a submission takes. */
export const SubmissionRunRequest = z.strictObject({
  submissionId: SubmissionId,
  idempotencyKey: IdempotencyKey,
  executionProfile: ExecutionProfileId.default(DETERMINISTIC_PROFILE.id),
  /**
   * Assess against this rubric release instead of the one locked into the submission. A
   * re-evaluation is always a new run, and its suggestions are never posted to the submission's
   * feedback, which belongs to the locked release.
   */
  reEvaluateWith: RubricReleaseRef.optional(),
});
/** A submission run request. */
export type SubmissionRunRequest = z.input<typeof SubmissionRunRequest>;

/**
 * A run as one caller may see it. The offering's teachers see the whole report; the student sees
 * only student-visible checks, without suggested scores, and a failure without its detail (which
 * can name teacher-only checks).
 */
export type RunView =
  | { view: "teacher"; runId: AssessmentRunId; state: RunState; report?: AssessmentReport; error?: RunError }
  | { view: "student"; runId: AssessmentRunId; state: RunState; report?: StudentAssessmentReport; failed?: true };

/** What an {@link AssessmentCi} is built from. */
export interface AssessmentCiOptions {
  /** The assessment service: every submission read and feedback write goes through it, and its policy checks. */
  assessment: AssessmentService;
  runs: AssessmentRuns;
}

/** Parses caller input, answering `validation-failed` rather than a raw Zod error. */
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
  return parsed.data;
}

/**
 * Assessment CI over submissions (roadmap E02): the "submitted artifact snapshot" entry point.
 *
 * - A run reads the submission and its pinned revisions through the assessment service as the
 *   caller, so only someone who may read the submission (its student or the offering's teachers)
 *   can run, or see, CI on it.
 * - The rubric release is the one the submission locked, unless the caller explicitly
 *   re-evaluates against another, which is a separate run.
 * - Results reach feedback only as suggested criterion scores labelled with the evaluator
 *   release, which the assessment service never shows the student and never makes official: an
 *   official grade still needs a teacher's direct approval.
 */
export class AssessmentCi {
  readonly #assessment: AssessmentService;
  readonly #runs: AssessmentRuns;

  constructor(options: AssessmentCiOptions) {
    this.#assessment = options.assessment;
    this.#runs = options.runs;
  }

  /**
   * Requests and executes a run on a submission, returning the existing run for a key already
   * requested, as the caller may see it (see {@link RunView}).
   */
  async run(caller: Caller, rawRequest: SubmissionRunRequest): Promise<RunView> {
    const request = parse(SubmissionRunRequest, rawRequest);
    const submission = await this.#assessment.getSubmission(caller, request.submissionId);
    if (submission.withdrawnAt !== undefined) throw new EducateOsError("conflict", "This submission was withdrawn.");
    const rubric = request.reEvaluateWith ?? submission.rubric;
    if (rubric === undefined) throw new EducateOsError("validation-failed", "This submission has no rubric to assess against.");
    const run = await this.#runs.request({
      submissionDigest: submission.submissionDigest,
      rubricRelease: rubric,
      executionProfile: request.executionProfile,
      idempotencyKey: request.idempotencyKey,
    });
    return viewOf(caller, submission, await this.#runs.execute(run.id, this.#work(caller, submission)));
  }

  /** A run on a submission, as the caller may see it; `not-found` if the run did not assess this submission. */
  async view(caller: Caller, rawSubmissionId: SubmissionId, rawRunId: AssessmentRunId): Promise<RunView> {
    const { submission, run } = await this.#runOn(caller, rawSubmissionId, rawRunId);
    return viewOf(caller, submission, run);
  }

  /**
   * Posts a completed run's suggested criterion scores to the submission's feedback, each labelled
   * `<evaluator>@<release>`. The assessment service decides whether the caller may give feedback,
   * keeps suggestions from the student, and keeps them out of official grades.
   */
  async suggestScores(caller: Caller, rawSubmissionId: SubmissionId, rawRunId: AssessmentRunId): Promise<CriterionScore[]> {
    const { submission, run } = await this.#runOn(caller, rawSubmissionId, rawRunId);
    if (run.report === undefined) throw new EducateOsError("conflict", `This run is ${run.state}, so it has nothing to suggest.`);
    const locked = submission.rubric;
    if (locked === undefined || locked.rubricId !== run.key.rubricRelease.rubricId || locked.version !== run.key.rubricRelease.version) {
      throw new EducateOsError("conflict", "This run re-evaluated the work against another rubric release, so it is not posted as feedback.");
    }
    const scores: CriterionScore[] = [];
    for (const criterion of run.report.criteria) {
      for (const suggestion of criterion.suggestions) {
        scores.push(await this.#assessment.scoreCriterion(caller, submission.id, {
          criterionId: criterion.criterionId,
          points: suggestion.points,
          maxPoints: suggestion.maxPoints,
          suggestedBy: { kind: "evaluator", evaluatorId: evaluatorLabel(suggestion.evaluator) },
        }));
      }
    }
    return scores;
  }

  async #runOn(caller: Caller, rawSubmissionId: SubmissionId, rawRunId: AssessmentRunId): Promise<{ submission: SubmissionSnapshot; run: AssessmentRun }> {
    const submissionId = parse(SubmissionId, rawSubmissionId);
    const runId = parse(AssessmentRunId, rawRunId);
    const submission = await this.#assessment.getSubmission(caller, submissionId);
    const run = await this.#runs.get(runId);
    if (run.key.submissionDigest !== submission.submissionDigest) throw new EducateOsError("not-found", `Assessment run ${runId} was not found.`);
    return { submission, run };
  }

  /** The submission's work, read as the caller through the assessment service, which verifies each revision. */
  #work(caller: Caller, submission: SubmissionSnapshot): SubmittedWork {
    return {
      items: submission.items,
      offeringId: submission.offeringId,
      readText: async (item) => {
        const { content } = await this.#assessment.readSubmittedContent(caller, submission.id, item.artifactId);
        if (content.kind !== "text") throw new EducateOsError("unavailable", `Artifact ${item.artifactId} is not text.`);
        return content.text;
      },
    };
  }
}

/** `run` as `caller` may see it: the student's view for the submission's student, else the teacher's. */
function viewOf(caller: Caller, submission: SubmissionSnapshot, run: AssessmentRun): RunView {
  if (submission.studentPrincipalId === caller.principal.principalId) {
    return {
      view: "student",
      runId: run.id,
      state: run.state,
      ...(run.report === undefined ? {} : { report: studentReport(run.report) }),
      ...(run.state === "failed" ? { failed: true as const } : {}),
    };
  }
  return {
    view: "teacher",
    runId: run.id,
    state: run.state,
    ...(run.report === undefined ? {} : { report: run.report }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}
