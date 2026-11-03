import type { ActivityStep, ArtifactView } from "../model.ts";
import type { SubmittableWork } from "./SubmitSection.tsx";

/**
 * The student's work on one activity, as both presentations of the activity page use it: what is
 * saved, how to save more, and what a submission would hand in.
 */
export interface ActivityWork {
  /** A finished class: the work is shown, not edited. */
  readOnly: boolean;
  /** The saved work, by step ID. */
  saved: ReadonlyMap<string, ArtifactView>;
  /** The title a step's work is saved under. */
  titleFor: (step: ActivityStep) => string;
  /** Where a step's unsaved changes are kept. */
  draftKeyFor: (step: ActivityStep) => string;
  ensureWorkspace: () => Promise<string>;
  onSaved: (stepId: string, view: ArtifactView) => void;
  /** The saved versions a submission would hand in. */
  submittable: SubmittableWork[];
  /** Whether any step has changes not yet saved. */
  unsaved: boolean;
  /** Changes when a submission is made, so feedback is read again. */
  feedbackKey: string;
  onSubmitted: () => void;
}
