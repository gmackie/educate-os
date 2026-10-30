import { z } from "zod";
import { ArtifactId, ContentDigest, EducateOsError, PrincipalId, RevisionId } from "@educateos/contracts";
import { AssignmentId, RubricReleaseRef } from "@educateos/assessment";
import { canonicalJson, digestJson, WorkshopAssessmentBlueprint } from "@educateos/assessment-sdk";

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

/** Exact source-only envelope accepted solely from the configured Gatekeeper service capability. */
export const GadgetSourceCheckpoint = z.strictObject({
  format: z.literal("workshop.gadget-source.v1"),
  workspaceId: z.string().min(1).max(256),
  gadgetId: z.int().nonnegative(),
  commitId: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDigest: ContentDigest,
  files: z.array(z.tuple([z.string().min(1).max(256), z.string().max(262144)])).min(1).max(64),
  blueprint: z.strictObject({ id: z.string().min(1).max(256), commitId: z.string().regex(/^[a-f0-9]{40}$/) }),
  policy: z.literal("educateos-source-v1"),
});
/** Approved checkpoint requests contain no caller-selected principal, workspace or artifact destination. */
export const GadgetCheckpointSubmission = z.strictObject({
  requestId: z.uuid(),
  blueprint: WorkshopAssessmentBlueprint.shape.blueprint,
  checkpoint: GadgetSourceCheckpoint,
});
/** The source envelope is text for the existing teacher evidence viewer, never executable content. */
export const GADGET_CHECKPOINT_MEDIA_TYPE = "text/vnd.educateos.gadget-source+json";

/** Recheck integrity, reviewed upstream and public instructions before storing any student bytes. */
export async function checkpointContent(input: z.infer<typeof GadgetCheckpointSubmission>, pin: WorkshopAssessmentBlueprint): Promise<string> {
  const source = input.checkpoint;
  if (canonicalJson(input.blueprint) !== canonicalJson(pin.blueprint)
    || source.blueprint.id !== pin.blueprint.id || source.blueprint.commitId !== pin.blueprint.commitId) {
    throw new EducateOsError("conflict", "The checkpoint does not derive from the reviewed release.");
  }
  const sorted = source.files.toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (new Set(sorted.map(([path]) => path)).size !== sorted.length || await digestJson(sorted) !== source.sourceDigest) {
    throw new EducateOsError("validation-failed", "The checkpoint source fingerprint does not match.");
  }
  const manifest = sorted.find(([path]) => path === "educateos.assessment.json")?.[1];
  try {
    if (manifest === undefined || await digestJson(JSON.parse(manifest)) !== pin.assessmentDigest) throw new Error();
  } catch {
    throw new EducateOsError("conflict", "The checkpoint public assessment differs from the reviewed release.");
  }
  // LearningArtifacts normalizes text to NFC. ASCII JSON escapes preserve exact original source
  // code points (including decomposed Unicode) while keeping the existing text evidence viewer.
  const text = canonicalJson({ ...source, files: sorted }).replace(/[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const bytes = new TextEncoder().encode(text).byteLength;
  const accepted = pin.definition.tasks.some((task) => (task.kind === "gadget" || task.kind === "programming")
    && task.evidence.some((evidence) => evidence.mediaTypes.includes(GADGET_CHECKPOINT_MEDIA_TYPE) && bytes <= evidence.maxBytes));
  if (bytes > 262144 || !accepted) throw new EducateOsError("validation-failed", "This assessment does not accept this source checkpoint format or size.");
  return text;
}
