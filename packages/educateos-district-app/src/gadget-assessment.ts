import { z } from "zod";
import { ArtifactId, EducateOsError, PrincipalId, RevisionId } from "@educateos/contracts";
import { AssignmentId, RubricReleaseRef } from "@educateos/assessment";
import { WorkshopAssessmentBlueprint } from "@educateos/assessment-sdk";

/** A teacher-reviewed Workshop release, pinned once to an installed assignment and its rubric. */
export const GadgetAssessmentBinding = z.strictObject({
  assignmentId: AssignmentId,
  blueprint: WorkshopAssessmentBlueprint,
  rubric: RubricReleaseRef,
  boundBy: PrincipalId,
  boundAt: z.iso.datetime(),
});
/** A district-local pin; never part of a shared blueprint export. */
export type GadgetAssessmentBinding = z.infer<typeof GadgetAssessmentBinding>;

/** Only immutable owned district artifacts and the configured release may be submitted. */
export const GadgetAssessmentSubmission = z.strictObject({
  blueprint: WorkshopAssessmentBlueprint.shape.blueprint,
  revisions: z.array(z.strictObject({ artifactId: ArtifactId, revisionId: RevisionId })).min(1).max(50),
});

/** Immutable district-local assignment pins. No student-facing operation writes this store. */
export interface GadgetAssessmentStore {
  get(assignmentId: AssignmentId): Promise<GadgetAssessmentBinding | undefined>;
  /** Atomically inserts a pin or returns the identical existing pin; a changed pin is refused. */
  bind(binding: GadgetAssessmentBinding): Promise<GadgetAssessmentBinding>;
}

/** Rejects attempts to retarget an already-configured assignment, including rubric changes. */
export function sameGadgetAssessmentPin(left: GadgetAssessmentBinding, right: GadgetAssessmentBinding): boolean {
  return left.blueprint.assessmentDigest === right.blueprint.assessmentDigest
    && JSON.stringify(left.blueprint.blueprint) === JSON.stringify(right.blueprint.blueprint)
    && JSON.stringify(left.rubric) === JSON.stringify(right.rubric);
}

/** In-memory store used by the district harness. Production uses the SQLite implementation. */
export class InMemoryGadgetAssessmentStore implements GadgetAssessmentStore {
  readonly #bindings = new Map<string, GadgetAssessmentBinding>();
  async get(id: AssignmentId): Promise<GadgetAssessmentBinding | undefined> {
    return structuredClone(this.#bindings.get(id));
  }
  async bind(raw: GadgetAssessmentBinding): Promise<GadgetAssessmentBinding> {
    const binding = GadgetAssessmentBinding.parse(raw);
    const current = this.#bindings.get(binding.assignmentId);
    if (current !== undefined) {
      if (!sameGadgetAssessmentPin(current, binding)) throw new EducateOsError("conflict", "This assignment already pins another Gadget assessment release.");
      return structuredClone(current);
    }
    this.#bindings.set(binding.assignmentId, structuredClone(binding));
    return structuredClone(binding);
  }
}
