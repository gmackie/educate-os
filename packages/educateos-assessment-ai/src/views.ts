// Rubric report view models for future teacher and student UIs: pure functions from records to
// plain data, with no React and no I/O. The student view is built by filtering, never by trusting
// its caller to have filtered, so it can be handed every record a submission has.
import type { AssessmentRunId, RevisionId, SubmissionId } from "@educateos/contracts";
import type { CriterionId } from "@educateos/assessment";
import {
  evaluatorLabel,
  studentReport,
  type AssessmentReport,
  type CheckVisibility,
  type CriterionEvidence,
  type RubricCriterion,
  type RubricLevel,
  type RubricRelease,
  type TextRange,
} from "@educateos/assessment-ci";
import type { ArtifactId, UsdNano } from "@educateos/contracts";
import { AI_FEEDBACK_NOTICE, AI_SUGGESTED, type AiEvidence, type AiExcerpt, type AiSkipReason, type Uncertainty } from "./ai-feedback.ts";
import { modelLabel } from "./model-port.ts";
import type { AiFeedbackReport, OptionalRecords, OptionalRun, OptionalRunError, OverrideDecision, SandboxReport, TeacherOverride } from "./model.ts";
import type { AiHelpPolicy } from "./profiles.ts";

/** Where a piece of evidence came from, as a report labels it. */
export type EvidenceSource =
  | { kind: "deterministic"; label: string; checkId: string; visibility: CheckVisibility }
  | { kind: "sandbox"; label: string; runId: AssessmentRunId; checkId: string; visibility: CheckVisibility }
  | { kind: typeof AI_SUGGESTED; label: string; runId: AssessmentRunId };

/** An excerpt, linked to the revision range it cites in the shape of a feedback anchor. */
export interface ExcerptLink {
  artifactId: ArtifactId;
  revisionId: RevisionId;
  range: TextRange;
  /** The quoted text, for AI excerpts, which were verified to match it. */
  quote?: string;
  anchor: { artifactId: ArtifactId; revisionId: RevisionId; region: { kind: "text-range"; start: number; end: number } };
}

/** One piece of evidence in a report. */
export interface EvidenceItem {
  source: EvidenceSource;
  observation: string;
  passed?: boolean;
  score?: number;
  explanation?: string;
  /** AI evidence only. */
  uncertainty?: Uncertainty;
  excerpts: ExcerptLink[];
}

/** A suggested level for a criterion, never a grade. */
export interface SuggestionView {
  source: "deterministic" | typeof AI_SUGGESTED;
  label: string;
  levelId: string;
  points: number;
  maxPoints: number;
}

/** A teacher action on one criterion's AI feedback from one run. Performing one is `AssessmentAi.override`. */
export type OverrideAction =
  | { action: "accept"; runId: AssessmentRunId; criterionId: CriterionId; levelId?: string }
  | { action: "reject"; runId: AssessmentRunId; criterionId: CriterionId }
  | { action: "edit"; runId: AssessmentRunId; criterionId: CriterionId; levelIds: string[] };

/** One criterion as the teacher sees it. */
export interface TeacherCriterionView {
  criterionId: CriterionId;
  title: string;
  levels: RubricLevel[];
  evidence: EvidenceItem[];
  suggestions: SuggestionView[];
  /** The decision in force for each AI run with feedback on this criterion. */
  overrides: { runId: AssessmentRunId; override: OverrideDecision; reason: string; decidedBy: string }[];
  /** The decisions still open: one set per AI run with feedback on this criterion and no override. */
  actions: OverrideAction[];
}

/** An AI run as the teacher sees it. */
export interface AiRunSummary {
  runId: AssessmentRunId;
  label: typeof AI_SUGGESTED;
  notice: string;
  model: string;
  state: OptionalRun["state"];
  status?: "completed" | "skipped" | "invalid-output";
  skipReason?: AiSkipReason;
  /** How many findings were dropped, such as for quoting text the work does not contain. */
  dropped: number;
  /** What the run cost, in nanodollars; round up to the cent to show it. */
  costUsdNano: UsdNano;
  error?: OptionalRunError;
  released: boolean;
  /** Present when the teacher may release this run's feedback to the student. */
  releaseAction?: { action: "release"; runId: AssessmentRunId };
}

/** A sandboxed run as the teacher sees it. */
export interface SandboxRunSummary {
  runId: AssessmentRunId;
  state: OptionalRun["state"];
  /** What the run cost, in nanodollars; round up to the cent to show it. */
  costUsdNano: UsdNano;
  error?: OptionalRunError;
}

/** The teacher's report: every source of evidence, labelled, and the actions still open. */
export interface TeacherReportView {
  view: "teacher";
  submissionId: SubmissionId;
  rubric: { rubricId: string; version: number; title: string };
  criteria: TeacherCriterionView[];
  ai: AiRunSummary[];
  sandbox: SandboxRunSummary[];
  /** Nothing in the report is a grade: an official grade needs a teacher's approval in the assessment service. */
  official: false;
}

/** The student's report: student-visible checks and released AI feedback only, with no scores. */
export interface StudentReportView {
  view: "student";
  submissionId: SubmissionId;
  rubric: { rubricId: string; version: number; title: string };
  criteria: { criterionId: CriterionId; title: string; evidence: EvidenceItem[] }[];
  /** Present when the report shows any AI feedback. */
  aiNotice?: string;
}

/** What both views are built from. */
export interface ReportInputs extends OptionalRecords {
  submissionId: SubmissionId;
  rubric: RubricRelease;
  /** The submission's deterministic run report, if it has completed. */
  deterministic?: AssessmentReport;
}

/** The lowest level any AI finding on `criterion` suggests: the cautious reading when findings disagree. */
export function aiSuggestedLevel(criterion: RubricCriterion, findings: readonly AiEvidence[]): RubricLevel | undefined {
  const suggested = new Set(findings.filter((f) => f.criterionId === criterion.id).flatMap((f) => (f.suggestedLevelId === undefined ? [] : [f.suggestedLevelId])));
  return criterion.levels.find((l) => suggested.has(l.id));
}

function link(excerpt: { artifact: ArtifactId; revision: RevisionId; range: TextRange; quote?: string }): ExcerptLink {
  return {
    artifactId: excerpt.artifact,
    revisionId: excerpt.revision,
    range: excerpt.range,
    ...(excerpt.quote === undefined ? {} : { quote: excerpt.quote }),
    anchor: { artifactId: excerpt.artifact, revisionId: excerpt.revision, region: { kind: "text-range", start: excerpt.range.start, end: excerpt.range.end } },
  };
}

function checkItem(source: EvidenceSource, e: CriterionEvidence): EvidenceItem {
  return {
    source,
    observation: e.observation,
    ...(e.passed === undefined ? {} : { passed: e.passed }),
    ...(e.score === undefined ? {} : { score: e.score }),
    explanation: e.explanation,
    excerpts: e.excerpts.map(link),
  };
}

function aiItem(run: AiFeedbackReport, f: AiEvidence): EvidenceItem {
  return {
    source: { kind: AI_SUGGESTED, label: modelLabel(run.model), runId: run.runId },
    observation: f.observation,
    uncertainty: f.uncertainty,
    excerpts: f.excerpts.map((e: AiExcerpt) => link(e)),
  };
}

function aiReports(runs: readonly OptionalRun[]): AiFeedbackReport[] {
  return runs.flatMap((r) => (r.report?.kind === "ai" ? [r.report] : []));
}

function sandboxReports(runs: readonly OptionalRun[]): SandboxReport[] {
  return runs.flatMap((r) => (r.report?.kind === "sandbox" ? [r.report] : []));
}

function findingsOf(report: AiFeedbackReport): AiEvidence[] {
  return report.outcome.status === "completed" ? report.outcome.findings : [];
}

/** The override in force for a run and criterion: the latest recorded. */
function overrideFor(overrides: readonly TeacherOverride[], runId: AssessmentRunId, criterionId: CriterionId): TeacherOverride | undefined {
  return overrides.findLast((o) => o.runId === runId && o.criterionId === criterionId);
}

function rubricHeader(rubric: RubricRelease) {
  return { rubricId: rubric.rubricId, version: rubric.version, title: rubric.title };
}

/**
 * The teacher's report on a submission: deterministic, sandboxed and AI evidence merged per
 * criterion, each labelled with its source, AI evidence with its uncertainty, and every excerpt
 * linked to the revision range it cites. Open decisions on AI feedback are listed as actions.
 */
export function teacherReportView(inputs: ReportInputs): TeacherReportView {
  const ai = aiReports(inputs.runs);
  const sandbox = sandboxReports(inputs.runs);
  const criteria = inputs.rubric.criteria.map((criterion): TeacherCriterionView => {
    const evidence: EvidenceItem[] = [];
    const suggestions: SuggestionView[] = [];
    const deterministic = inputs.deterministic?.criteria.find((c) => c.criterionId === criterion.id);
    for (const check of deterministic?.checks ?? []) {
      for (const e of check.evidence) evidence.push(checkItem({ kind: "deterministic", label: evaluatorLabel(check.evaluator), checkId: check.checkId, visibility: check.visibility }, e));
    }
    for (const s of deterministic?.suggestions ?? []) suggestions.push({ source: "deterministic", label: evaluatorLabel(s.evaluator), levelId: s.levelId, points: s.points, maxPoints: s.maxPoints });
    for (const report of sandbox) {
      for (const check of report.checks.filter((k) => k.criterionId === criterion.id)) {
        evidence.push(checkItem({ kind: "sandbox", label: evaluatorLabel(report.evaluator), runId: report.runId, checkId: check.checkId, visibility: check.visibility }, check.evidence));
      }
    }
    const overrides: TeacherCriterionView["overrides"] = [];
    const actions: OverrideAction[] = [];
    const maxPoints = criterion.levels.at(-1)!.points;
    for (const report of ai) {
      const findings = findingsOf(report).filter((f) => f.criterionId === criterion.id);
      if (findings.length === 0) continue;
      for (const f of findings) evidence.push(aiItem(report, f));
      const level = aiSuggestedLevel(criterion, findings);
      if (level !== undefined && maxPoints > 0) suggestions.push({ source: AI_SUGGESTED, label: modelLabel(report.model), levelId: level.id, points: level.points, maxPoints });
      const decided = overrideFor(inputs.overrides, report.runId, criterion.id);
      if (decided !== undefined) {
        overrides.push({ runId: report.runId, override: decided.override, reason: decided.reason, decidedBy: decided.decidedBy });
      } else {
        actions.push(
          { action: "accept", runId: report.runId, criterionId: criterion.id, ...(level === undefined ? {} : { levelId: level.id }) },
          { action: "reject", runId: report.runId, criterionId: criterion.id },
          { action: "edit", runId: report.runId, criterionId: criterion.id, levelIds: criterion.levels.map((l) => l.id) },
        );
      }
    }
    return { criterionId: criterion.id, title: criterion.title, levels: criterion.levels, evidence, suggestions, overrides, actions };
  });

  const released = new Set(inputs.releases.map((r) => r.runId));
  const aiRuns = inputs.runs.filter((r) => r.spec.kind === "ai").map((run): AiRunSummary => {
    const report = run.report?.kind === "ai" ? run.report : undefined;
    const outcome = report?.outcome;
    const releasable = inputs.aiHelpPolicy === "releasable" && outcome?.status === "completed" && !released.has(run.id);
    return {
      runId: run.id,
      label: AI_SUGGESTED,
      notice: AI_FEEDBACK_NOTICE,
      model: run.spec.kind === "ai" ? modelLabel(run.spec.model) : "",
      state: run.state,
      ...(outcome === undefined ? {} : { status: outcome.status }),
      ...(outcome?.status === "skipped" ? { skipReason: outcome.reason } : {}),
      dropped: outcome?.status === "completed" ? outcome.dropped.length : 0,
      costUsdNano: report?.costUsdNano ?? "0",
      ...(run.error === undefined ? {} : { error: run.error }),
      released: released.has(run.id),
      ...(releasable ? { releaseAction: { action: "release" as const, runId: run.id } } : {}),
    };
  });
  const sandboxRuns = inputs.runs.filter((r) => r.spec.kind === "sandbox").map((run): SandboxRunSummary => ({
    runId: run.id,
    state: run.state,
    costUsdNano: run.report?.kind === "sandbox" ? run.report.costUsdNano : "0",
    ...(run.error === undefined ? {} : { error: run.error }),
  }));
  return { view: "teacher", submissionId: inputs.submissionId, rubric: rubricHeader(inputs.rubric), criteria, ai: aiRuns, sandbox: sandboxRuns, official: false };
}

/** Whether a student may see an AI run's feedback: released by a teacher, under a policy that allows it. */
function visibleToStudent(policy: AiHelpPolicy, releasedRuns: ReadonlySet<string>, report: AiFeedbackReport): boolean {
  return policy === "releasable" && releasedRuns.has(report.runId) && report.outcome.status === "completed";
}

/**
 * The student's report on their submission: the deterministic run's student-visible checks,
 * student-visible sandboxed checks, and AI findings from runs a teacher released, except on
 * criteria the teacher rejected them for. It carries no suggested levels or scores, no teacher-only
 * check, no unreleased AI output, no model or cost, and no failure detail.
 */
export function studentReportView(inputs: ReportInputs): StudentReportView {
  const visible = inputs.deterministic === undefined ? undefined : studentReport(inputs.deterministic);
  const releasedRuns = new Set(inputs.releases.map((r) => r.runId));
  const ai = aiReports(inputs.runs).filter((r) => visibleToStudent(inputs.aiHelpPolicy, releasedRuns, r));
  const sandbox = sandboxReports(inputs.runs);
  let showsAi = false;
  const criteria = inputs.rubric.criteria.map((criterion) => {
    const evidence: EvidenceItem[] = [];
    for (const check of visible?.criteria.find((c) => c.criterionId === criterion.id)?.checks ?? []) {
      if (check.visibility !== "student-visible") continue;
      for (const e of check.evidence) evidence.push(checkItem({ kind: "deterministic", label: evaluatorLabel(check.evaluator), checkId: check.checkId, visibility: check.visibility }, e));
    }
    for (const report of sandbox) {
      for (const check of report.checks.filter((k) => k.criterionId === criterion.id && k.visibility === "student-visible")) {
        evidence.push(checkItem({ kind: "sandbox", label: evaluatorLabel(report.evaluator), runId: report.runId, checkId: check.checkId, visibility: check.visibility }, check.evidence));
      }
    }
    for (const report of ai) {
      if (overrideFor(inputs.overrides, report.runId, criterion.id)?.override.decision === "reject") continue;
      for (const f of findingsOf(report).filter((x) => x.criterionId === criterion.id)) {
        evidence.push({ ...aiItem(report, f), source: { kind: AI_SUGGESTED, label: AI_SUGGESTED, runId: report.runId } });
        showsAi = true;
      }
    }
    return { criterionId: criterion.id, title: criterion.title, evidence };
  }).filter((c) => c.evidence.length > 0);
  return { view: "student", submissionId: inputs.submissionId, rubric: rubricHeader(inputs.rubric), criteria, ...(showsAi ? { aiNotice: AI_FEEDBACK_NOTICE } : {}) };
}
