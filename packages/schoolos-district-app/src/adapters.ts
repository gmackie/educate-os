// The glue between domain services: each function here composes two or more packages at a seam
// one of them left open, and authorizes nothing itself beyond what the services it calls decide.
import {
  SchoolOsError,
  type ActivityDefinitionId,
  type ArtifactId,
  type AuthorityMap,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type SubmissionId,
  type VerifiedPrincipal,
  type WorkspaceId,
} from "@schoolos/contracts";
import { assertSyncWritable, DIRECTORY_ENTITY_KINDS, type AcademicStore } from "@schoolos/academics";
import type { PromotionLink, WorkspaceDirectory, WorkspaceStore } from "@schoolos/workspaces";
import type { LearningArtifacts, RevisionContent } from "@schoolos/learning-artifacts";
import type { AssessmentService, AssignmentBinding, CriterionScore } from "@schoolos/assessment";
import type { AssessmentCi, RunView } from "@schoolos/assessment-ci";
import type { ActivityInstallation, CurriculumService, OfferingScope } from "@schoolos/curriculum";
import { drainCourseFundingCancellations, type CourseFundingCancellations, type TermClosedEvent } from "@schoolos/ai-governance";
import { oneroster } from "@schoolos/integrations";
import type { AssignmentSettingsInput, RevisionContentBody } from "./routes.ts";
import type { RosterSourceStore } from "./stores.ts";
import type { z } from "zod";

/**
 * W01 → W02: keeping work from a closed class. W01's `promoteArtifact` records the link but leaves
 * it to W02 to confirm the artifact is really the caller's and in that workspace, so the check runs
 * first and the link is written only if it passes.
 */
export async function keepArtifact(
  artifacts: LearningArtifacts,
  workspaces: WorkspaceDirectory,
  caller: Caller,
  fromWorkspaceId: WorkspaceId,
  artifactId: ArtifactId,
): Promise<PromotionLink> {
  await artifacts.confirmPromotable(caller, fromWorkspaceId, artifactId);
  return workspaces.promoteArtifact(caller, fromWorkspaceId, artifactId);
}

/**
 * W01 → G01: the term-closed events the AI ledger reads. W01 records a `TermClosure` when a term's
 * workspaces close (and emits per-offering `course-ai-funding.cancelled` events); G01 stops course
 * funding on a `term.closed` event. Each closure becomes one event, read from the workspace store
 * on every decision, so funding ends the moment the closure is committed.
 */
export async function termClosedEvents(workspaces: WorkspaceStore, districtId: DistrictId): Promise<TermClosedEvent[]> {
  const { state } = await workspaces.load();
  return state.closures.map((closure) => ({ type: "term.closed", districtId, termId: closure.termId, closedAt: closure.closedAt }));
}

/**
 * C05 → E01: installing an activity into a class and assigning it. C05 pins the version and
 * publishes the Codex; E01 binds the installation to the offering as an assignment, which is what
 * makes it visible to students and submittable. The assignment takes the activity's title, due
 * date and permitted artifact types unless the teacher sets them; without a due date of either
 * kind, work is due at the end of the term.
 *
 * The two writes are not atomic: if the assignment is refused, the installation stays and the
 * error is returned. Installing again creates a new installation.
 */
export async function installAndAssign(input: {
  curriculum: CurriculumService;
  assessment: AssessmentService;
  caller: Caller;
  snapshot: DistrictDirectorySnapshot;
  definitionId: ActivityDefinitionId;
  version: number | undefined;
  offering: OfferingScope;
  settings: z.output<typeof AssignmentSettingsInput>;
}): Promise<{ installation: ActivityInstallation; assignment: AssignmentBinding }> {
  const { curriculum, assessment, caller, offering, settings } = input;
  const subject = caller.principal;
  const installation = await curriculum.install(subject, {
    definitionId: input.definitionId,
    offering,
    ...(input.version === undefined ? {} : { version: input.version }),
  });
  const definition = await curriculum.getDefinition(subject, installation.definitionId, installation.definitionVersion);
  const term = input.snapshot.terms.find((t) => t.id === installation.termId);
  const dueAt = installation.dueAt ?? settings.dueAt ?? (term === undefined ? undefined : `${term.endsOn}T23:59:59Z`);
  if (dueAt === undefined) throw new SchoolOsError("validation-failed", "Choose a due date for this assignment.");
  const assignment = await assessment.createAssignment(caller, {
    offeringId: offering.offeringId,
    activityId: installation.id,
    title: settings.title ?? definition.content.title,
    dueAt: new Date(dueAt).toISOString(),
    latePolicy: settings.latePolicy,
    attemptsAllowed: settings.attemptsAllowed,
    permittedArtifactTypes: definition.content.permittedArtifactTypes,
    feedbackVisibility: settings.feedbackVisibility,
    ...(settings.rubric === undefined ? {} : { rubric: settings.rubric }),
  });
  return { installation, assignment };
}

/**
 * A03 → A01 → W01: applying a OneRoster import. The importer returns the next directory and source
 * map only if the feed has no errors and the result passes `checkDirectoryIntegrity`; it is then
 * committed against the version it was planned from, so a concurrent change fails with `conflict`
 * rather than being overwritten. The roster must own every record type it writes (the authority
 * map says `external:oneroster`). Afterwards W01 revokes the course grants of everyone the roster
 * dropped; their workspaces and work are kept.
 */
export async function applyRosterImport(input: {
  directory: AcademicStore;
  sources: RosterSourceStore;
  authority: AuthorityMap;
  workspaces: WorkspaceDirectory;
  caller: Caller;
  files: oneroster.OneRosterCsvFiles;
  config: oneroster.OneRosterImportConfig;
  now: Date;
}): Promise<{ applied: boolean; preview: oneroster.OneRosterPreview; grantsRevoked: number }> {
  for (const kind of DIRECTORY_ENTITY_KINDS) assertSyncWritable(input.authority, kind, "oneroster");
  const { version, snapshot } = await input.directory.load();
  const current = { snapshot, sources: await input.sources.load() };
  const result = await oneroster.applyOneRosterImport({ current, files: input.files, config: input.config, now: input.now });
  if (!result.applied) return { applied: false, preview: result.preview, grantsRevoked: 0 };
  await input.directory.commit(result.next.snapshot, version);
  await input.sources.save(result.next.sources);
  const { revoked } = await input.workspaces.reconcileCourseGrants(input.caller);
  return { applied: true, preview: result.preview, grantsRevoked: revoked };
}

/** Where G01 keeps the course-funding cancellations it has drained. */
export interface FundingCancellationStore {
  /** The record as last saved, or `NO_FUNDING_CANCELLATIONS` before the first drain. */
  load(): Promise<CourseFundingCancellations>;
  /** Replaces the record. */
  save(next: CourseFundingCancellations): Promise<void>;
}

/**
 * A01 / A03 / A04 → W01 → G01: what follows every roster apply, whichever path applied it (a CSV
 * import, or a REST complete or delta sync through `runStoredRosterSync`'s `afterApply`). W01
 * revokes the course grants of everyone the roster dropped, acting as the district's roster
 * service principal on the `system` channel, so a scheduled sync with nobody signed in does
 * exactly what an administrator's import does; the principal needs authority over the district's
 * enrollments, as a district-admin grant gives it. G01 then drains the `course-ai-funding.cancelled`
 * events that emitted.
 *
 * Both steps are idempotent, so if either fails it is safely run again after the next apply. Call
 * it once the directory the apply produced is committed.
 */
export async function reconcileAfterRosterApply(input: {
  workspaces: WorkspaceDirectory;
  workspaceStore: WorkspaceStore;
  directory: AcademicStore;
  rosterService: VerifiedPrincipal;
  fundingCancellations: FundingCancellationStore;
}): Promise<{ grantsRevoked: number; cancellationsDrained: number }> {
  const { revoked } = await input.workspaces.reconcileCourseGrants({ principal: input.rosterService, channel: "system" });
  const [{ state }, { snapshot }, record] = await Promise.all([
    input.workspaceStore.load(),
    input.directory.load(),
    input.fundingCancellations.load(),
  ]);
  const { next, drained } = drainCourseFundingCancellations(record, state.events, snapshot);
  await input.fundingCancellations.save(next);
  return { grantsRevoked: revoked, cancellationsDrained: drained };
}

/**
 * E01 → E02: running Assessment CI on a submission and posting its suggestions. `AssessmentCi`
 * reads the submission as the caller (so only its student or the offering's teachers can run it)
 * and leaves posting a completed run's suggestions as a second step; a teacher's run does both, so
 * the teacher sees the evaluators' suggested scores beside the work. Suggestions are labelled with
 * the evaluator release, never shown to the student, and never official.
 */
export async function runCiAndSuggest(
  ci: AssessmentCi,
  caller: Caller,
  submissionId: SubmissionId,
  idempotencyKey: string,
): Promise<{ run: Extract<RunView, { view: "teacher" }>; suggestions: CriterionScore[] }> {
  const run = await ci.run(caller, { submissionId, idempotencyKey });
  // Only a teacher's own run is posted: the student's view of a run never carries suggestions.
  if (run.view !== "teacher") throw new SchoolOsError("forbidden", "Only the offering's teachers run checks from here.");
  const suggestions = run.state === "completed" ? await ci.suggestScores(caller, submissionId, run.runId) : [];
  return { run, suggestions };
}

/** Revision content as the API returns it: bytes as base64, since JSON cannot carry them. */
export function contentBody(content: RevisionContent): RevisionContentBody {
  if (content.kind !== "bytes") return content;
  let binary = "";
  for (let i = 0; i < content.bytes.length; i += 0x8000) binary += String.fromCharCode(...content.bytes.subarray(i, i + 0x8000));
  return { kind: "bytes", base64: btoa(binary) };
}
