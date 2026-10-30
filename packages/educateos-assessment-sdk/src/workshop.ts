import { z } from "zod";
import { AssessmentDefinition, Digest, Id } from "./contracts.ts";
import { digestJson, freezeJson, releaseAssessment, verifyAssessment } from "./canonical.ts";

/** Public assessment instructions carried as an ordinary file through Workshop publish/import/update. */
export const WORKSHOP_ASSESSMENT_FILE = "educateos.assessment.json";
/** Exact Workshop source pin. The district's configured Workshop determines the namespace of `id`. */
export const WorkshopBlueprintRef = z.strictObject({
  id: Id,
  commitId: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDigest: Digest,
});
/** An immutable Workshop release reference; it grants no authority. */
export type WorkshopBlueprintRef = z.infer<typeof WorkshopBlueprintRef>;
/** Public-only exchange envelope. Local assignments, student artifacts and private rubric config stay out. */
export const WorkshopAssessmentBlueprint = z.strictObject({
  format: z.literal("educateos.workshop-assessment.v1"),
  definition: AssessmentDefinition,
  assessmentDigest: Digest,
  blueprint: WorkshopBlueprintRef,
});
/** Public instructions attached to one exact Workshop release. */
export type WorkshopAssessmentBlueprint = z.infer<typeof WorkshopAssessmentBlueprint>;

/** Installer-provided authority for one Workshop; never construct this port from client URLs. */
export interface WorkshopAssessmentReleaseSource {
  /** Fetch the exact published Git release from the configured Workshop. */
  getBlueprintRelease(id: string, commitId: string): Promise<unknown>;
}

/**
 * Independently verify a proposed/local pin against the configured Workshop's authenticated
 * release capability. The Workshop verifies Git objects; this side recomputes the SHA-256 and
 * public assessment. No publisher identity, latest-release fallback or student data is sent.
 */
export async function verifyWorkshopAssessmentBlueprint(
  rawPin: unknown,
  releases: WorkshopAssessmentReleaseSource | undefined,
): Promise<WorkshopAssessmentBlueprint> {
  const pin = await importWorkshopAssessmentBlueprint(rawPin);
  if (!releases) throw new Error("Workshop release verification unavailable.");
  let verified: WorkshopAssessmentBlueprint;
  try {
    verified = await pinWorkshopAssessmentBlueprint(pin.blueprint.id,
      await releases.getBlueprintRelease(pin.blueprint.id, pin.blueprint.commitId));
  } catch {
    // The upstream failure may contain response content; never forward it to a student or log it.
    throw new Error("Workshop release verification failed.");
  }
  if (verified.blueprint.commitId !== pin.blueprint.commitId
      || verified.blueprint.sourceDigest !== pin.blueprint.sourceDigest
      || verified.assessmentDigest !== pin.assessmentDigest) {
    throw new Error("Workshop release does not match the reviewed pin.");
  }
  return pin;
}

/**
 * Import a public pin and verify its definition. This is NOT publisher authentication: an admin
 * must obtain the source from their configured Workshop, or explicitly review an imported archive.
 */
export async function importWorkshopAssessmentBlueprint(raw: unknown): Promise<WorkshopAssessmentBlueprint> {
  const blueprint = WorkshopAssessmentBlueprint.parse(raw);
  await verifyAssessment(blueprint.definition, blueprint.assessmentDigest);
  return freezeJson(blueprint);
}

/** Export public instructions and source references only; unknown/local-data fields are rejected. */
export async function exportWorkshopAssessmentBlueprint(raw: unknown): Promise<string> {
  return JSON.stringify(await importWorkshopAssessmentBlueprint(raw), null, 2);
}

/**
 * Extract the assessment from PublicApi.getBlueprintRelease(id, commitId)'s verified source.
 * Call this on the trusted host's RPC result, not a student's asserted release. Workshop verifies
 * Git objects; this adapter independently checks the source SHA-256 and strictly parses the public
 * file. Updating/following a blueprint never silently changes an existing returned pin.
 */
export async function pinWorkshopAssessmentBlueprint(blueprintId: string, rawRelease: unknown): Promise<WorkshopAssessmentBlueprint> {
  const release = z.strictObject({
    commitId: WorkshopBlueprintRef.shape.commitId,
    sourceDigest: Digest,
    files: z.array(z.tuple([z.string().min(1).max(1024), z.string()])).max(100_000),
  }).parse(rawRelease);
  if (new Set(release.files.map(([path]) => path)).size !== release.files.length) throw new Error("Duplicate source path.");
  const files = release.files.toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (await digestJson(files) !== release.sourceDigest) throw new Error("Workshop source digest mismatch.");
  const source = files.find(([path]) => path === WORKSHOP_ASSESSMENT_FILE)?.[1];
  if (source === undefined) throw new Error("Blueprint has no public assessment definition.");
  const assessment = await releaseAssessment(JSON.parse(source));
  return importWorkshopAssessmentBlueprint({
    format: "educateos.workshop-assessment.v1",
    definition: assessment.definition,
    assessmentDigest: assessment.digest,
    blueprint: { id: blueprintId, commitId: release.commitId, sourceDigest: release.sourceDigest },
  });
}
