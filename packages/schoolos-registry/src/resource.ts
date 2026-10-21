import { z } from "zod";
import { ResourceId } from "./ids.ts";
import { CompetencyRef, HumanReview, ImmutableRelease, Provenance, RegistryUri } from "./primitives.ts";

/** What kind of thing a resource is (roadmap §5.1). */
export const ResourceKind = z.enum([
  "web-page",
  "document",
  "video",
  "lti-tool",
  "dataset",
  "gadget-blueprint",
  "interactive",
  "learning-pack",
]);
/** A resource kind. */
export type ResourceKind = z.infer<typeof ResourceKind>;

/**
 * How SchoolOS may use a resource's content (roadmap §5.3): link to it, embed it, quote a
 * permitted excerpt, or hold a licensed copy.
 */
export const RightsMode = z.enum(["link", "embed", "excerpt", "licensed-copy"]);
/** A rights mode. */
export type RightsMode = z.infer<typeof RightsMode>;

/**
 * The license a resource is used under. Rights start as the source's claim. Only a named person
 * can mark them verified; neither an import nor an AI review certifies rights on its own.
 */
export const ResourceLicense = z.strictObject({
  name: z.string().min(1).max(200),
  licenseUri: RegistryUri.optional(),
  attribution: z.string().max(2000).optional(),
  permittedUses: z.array(RightsMode).min(1),
  verification: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("claimed") }),
    z.strictObject({ status: z.literal("verified"), ...HumanReview.shape }),
  ]),
});
/** A resource license. */
export type ResourceLicense = z.infer<typeof ResourceLicense>;

/** Who a resource is meant for. Education levels are kept as published, like a node's. */
export const ResourceAudience = z
  .strictObject({
    educationLevels: z.array(z.string().min(1)).optional(),
    ageRange: z.strictObject({ minYears: z.number().int().min(0).max(120), maxYears: z.number().int().min(0).max(120) }).optional(),
  })
  .refine((audience) => !audience.ageRange || audience.ageRange.minYears <= audience.ageRange.maxYears, {
    path: ["ageRange"],
    message: "minYears must not exceed maxYears",
  });
/** A resource audience. */
export type ResourceAudience = z.infer<typeof ResourceAudience>;

/**
 * A resource's accessibility, in schema.org `accessibilityFeature` and `accessibilityHazard`
 * terms (for example `captions`, `flashing`).
 */
export const ResourceAccessibility = z.strictObject({
  features: z.array(z.string().min(1).max(100)),
  hazards: z.array(z.string().min(1).max(100)),
  summary: z.string().max(2000).optional(),
});
/** Resource accessibility attributes. */
export type ResourceAccessibility = z.infer<typeof ResourceAccessibility>;

/**
 * A claim that a resource teaches, practices or assesses a competency at a pinned framework
 * revision. A suggestion becomes reviewed only through a named person.
 */
export const ResourceAlignment = z.strictObject({
  competency: CompetencyRef,
  purpose: z.enum(["teaches", "practices", "assesses"]),
  review: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("suggested") }),
    z.strictObject({ status: z.literal("reviewed"), ...HumanReview.shape }),
  ]),
});
/** A resource alignment. */
export type ResourceAlignment = z.infer<typeof ResourceAlignment>;

/** Where a record stands in review. Approval and rejection always name who decided. */
export const ReviewStatus = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unreviewed") }),
  z.strictObject({ status: z.literal("approved"), ...HumanReview.shape }),
  z.strictObject({ status: z.literal("rejected"), ...HumanReview.shape, reason: z.string().min(1).max(2000) }),
]);
/** A review status. */
export type ReviewStatus = z.infer<typeof ReviewStatus>;

/** One immutable release of a resource in the registry. */
export const ResourceDescriptor = z.strictObject({
  id: ResourceId,
  release: ImmutableRelease,
  kind: ResourceKind,
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  /** Where the resource itself lives. */
  locator: RegistryUri,
  license: ResourceLicense,
  audience: ResourceAudience,
  accessibility: ResourceAccessibility,
  alignments: z.array(ResourceAlignment),
  review: ReviewStatus,
  provenance: Provenance,
});
/** A resource descriptor. */
export type ResourceDescriptor = z.infer<typeof ResourceDescriptor>;
