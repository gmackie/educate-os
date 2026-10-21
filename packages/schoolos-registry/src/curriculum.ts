import { z } from "zod";
import { CurriculumPackId, EvidenceContractId, LearningUnitId, ResourceId } from "./ids.ts";
import { ImmutableRelease, Provenance } from "./primitives.ts";
import { ResourceAudience, ReviewStatus } from "./resource.ts";

/**
 * One entry in a learning unit, pinned to an exact release so a unit never changes because
 * something it references was updated.
 */
export const LearningUnitItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("resource"), resourceId: ResourceId, releaseVersion: ImmutableRelease.shape.version }),
  z.strictObject({ kind: z.literal("evidence-contract"), contractId: EvidenceContractId, version: z.number().int().positive() }),
]);
/** A learning unit item. */
export type LearningUnitItem = z.infer<typeof LearningUnitItem>;

/** An ordered sequence of resources and evidence contracts that is taught as one unit. */
export const LearningUnit = z.strictObject({
  id: LearningUnitId,
  release: ImmutableRelease,
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  items: z.array(LearningUnitItem).min(1),
  provenance: Provenance,
});
/** A learning unit. */
export type LearningUnit = z.infer<typeof LearningUnit>;

/** A learning unit pinned to one release. */
export const LearningUnitRef = z.strictObject({
  unitId: LearningUnitId,
  releaseVersion: ImmutableRelease.shape.version,
});
/** A learning unit reference. */
export type LearningUnitRef = z.infer<typeof LearningUnitRef>;

/** An ordered, composable set of learning units published as one release. */
export const CurriculumPack = z
  .strictObject({
    id: CurriculumPackId,
    release: ImmutableRelease,
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    audience: ResourceAudience,
    units: z.array(LearningUnitRef).min(1),
    review: ReviewStatus,
    provenance: Provenance,
  })
  .refine((pack) => new Set(pack.units.map((u) => u.unitId)).size === pack.units.length, {
    path: ["units"],
    message: "a unit appears in a pack at most once",
  });
/** A curriculum pack. */
export type CurriculumPack = z.infer<typeof CurriculumPack>;
