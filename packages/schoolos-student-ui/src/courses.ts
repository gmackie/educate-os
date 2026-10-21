// How the Learning Home groups a student's classes and work. Pure functions over API data, so the
// rules (what counts as a past course, which saved work belongs to which step) are tested directly.
import type { ActivityContent, ActivityStep, ArtifactType, ArtifactView, Assignment, CourseWorkspaceView, Me, WorkspaceView } from "./model.ts";

/** A class on the Home screen: its offering, and the student's workspace for it once one exists. */
export interface CourseEntry {
  offeringId: string;
  workspace?: CourseWorkspaceView;
}

const FINISHED: ReadonlySet<WorkspaceView["lifecycle"]> = new Set(["completed", "retained", "eligible-for-deletion"]);

/** Whether a course workspace belongs to a term that has finished, which makes it read-only. */
export const isFinished = (workspace: WorkspaceView | undefined): boolean => workspace !== undefined && FINISHED.has(workspace.lifecycle);

/**
 * Whether work can be kept from a finished course yet. The workspace service allows it only once
 * the term has been closed, which is when the workspace is `retained`.
 */
export const canKeepFrom = (workspace: WorkspaceView): boolean =>
  workspace.kind === "course" && (workspace.lifecycle === "retained" || workspace.lifecycle === "eligible-for-deletion");

/**
 * The student's classes, split into this term's and finished ones. A class the student is enrolled
 * in but has not opened yet has no workspace and is current; a class whose term finished is past
 * whatever the enrollment says, since closing a term never removes the work.
 */
export const groupCourses = (me: Me, workspaces: readonly WorkspaceView[]): { current: CourseEntry[]; past: CourseEntry[] } => {
  const byOffering = new Map<string, CourseWorkspaceView>();
  for (const workspace of workspaces) if (workspace.kind === "course") byOffering.set(workspace.offeringId, workspace);

  const current: CourseEntry[] = [];
  const past: CourseEntry[] = [];
  const seen = new Set<string>();
  const place = (offeringId: string) => {
    if (seen.has(offeringId)) return;
    seen.add(offeringId);
    const workspace = byOffering.get(offeringId);
    (isFinished(workspace) ? past : current).push(workspace === undefined ? { offeringId } : { offeringId, workspace });
  };
  for (const enrollment of me.enrollments) if (enrollment.role === "student") place(enrollment.offeringId);
  for (const offeringId of byOffering.keys()) place(offeringId);
  return { current, past };
};

/** The personal workspace, if the student has opened it. */
export const personalWorkspace = (workspaces: readonly WorkspaceView[]): WorkspaceView | undefined =>
  workspaces.find((workspace) => workspace.kind === "personal");

/** The steps that ask the student to produce something. */
export const workSteps = (content: ActivityContent): ActivityStep[] => content.steps.filter((step) => step.response.kind !== "none");

/**
 * The title a step's work is saved under. Artifacts carry no link to an assignment yet, so the
 * title is what finds a step's work again: the assignment's title, then the step's.
 */
export const workTitle = (assignment: Assignment, step: ActivityStep): string => `${assignment.title}: ${step.title}`.slice(0, 200);

/** The saved work for each step of an assignment, by step ID. */
export const workByStep = (assignment: Assignment, content: ActivityContent, artifacts: readonly ArtifactView[]): Map<string, ArtifactView> => {
  const found = new Map<string, ArtifactView>();
  for (const step of workSteps(content)) {
    const title = workTitle(assignment, step);
    const match = artifacts.find((view) => view.artifact.title === title && view.artifact.deletedAt === undefined);
    if (match !== undefined) found.set(step.id, match);
  }
  return found;
};

/** The artifact type a step's work is kept as. */
export const stepArtifactType = (step: ActivityStep): ArtifactType | undefined => {
  switch (step.response.kind) {
    case "none":
      return undefined;
    case "writing":
      return "document";
    case "dataset":
      return "dataset";
    case "artifact":
      return step.response.artifactType;
  }
};

/** Where a student is with an activity. */
export type ActivityStatus = "not-started" | "in-progress" | "submitted" | "feedback-ready";

/** Each status as the activity list shows it. */
export const STATUS_LABEL: Readonly<Record<ActivityStatus, string>> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  submitted: "Submitted",
  "feedback-ready": "Feedback ready",
};
