import { z } from "zod";
import { AssessmentDefinition, BoundInstance, Digest, ReleaseRef } from "./contracts.ts";
import { freezeJson, verifyAssessment } from "./canonical.ts";
import type { AssessmentRuntime } from "./runtime.ts";

/** Reference to reviewed .gadget bytes. Import never fetches, executes, or includes the archive. */
export const GadgetRelease = ReleaseRef.extend({ file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.gadget$/) });
/** Public-only exchange envelope. No district bindings, records, config, archive, or arbitrary metadata. */
export const AssessmentBlueprint = z.strictObject({
  format: z.literal("educateos.assessment-blueprint.v1"), definition: AssessmentDefinition, assessmentDigest: Digest, gadget: GadgetRelease,
});
/** A reusable public assessment blueprint. */
export type AssessmentBlueprint = z.infer<typeof AssessmentBlueprint>;
/** Strict import of a public-only manifest, preserving the assessment's immutable pin. */
export async function importAssessmentBlueprint(raw: unknown): Promise<AssessmentBlueprint> {
  const blueprint = AssessmentBlueprint.parse(raw);
  await verifyAssessment(blueprint.definition, blueprint.assessmentDigest);
  return freezeJson(blueprint);
}
/** Export only a validated public manifest; accidentally attached student records cause rejection. */
export async function exportAssessmentBlueprint(raw: unknown): Promise<string> {
  return JSON.stringify(await importAssessmentBlueprint(raw), null, 2);
}
/** Bind a shared release locally. This creates no data access capability; host authorization is separate. */
export async function bindAssessmentBlueprint(raw: unknown, local: { districtId: string; instanceId: string }): Promise<BoundInstance> {
  const blueprint = await importAssessmentBlueprint(raw);
  return freezeJson(BoundInstance.parse({ ...local, assessmentDigest: blueprint.assessmentDigest }));
}
/** Narrow host-side Gadget capability: it cannot choose a district, learner, release, or review action. */
export function createGadgetAssessment(runtime: AssessmentRuntime) {
  return Object.freeze({ submit: (request: unknown) => runtime.evaluate(request) });
}
