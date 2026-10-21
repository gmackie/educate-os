import { z } from "zod";

/**
 * Prefixes for registry record identifiers, following the `<prefix>_<body>` convention of
 * `@schoolos/contracts`, so an ID of one kind never parses as another. Frameworks, nodes and
 * associations are keyed by their publisher URIs instead; these are for records SchoolOS mints.
 */
export const REGISTRY_ID_PREFIXES = {
  resource: "rsc",
  curriculumPack: "pck",
  learningUnit: "unt",
  evidenceContract: "evc",
} as const;

/** The registry record kinds that have their own identifier type. */
export type RegistryIdKind = keyof typeof REGISTRY_ID_PREFIXES;

function idSchema<K extends RegistryIdKind>(kind: K) {
  return z
    .string()
    .regex(new RegExp(`^${REGISTRY_ID_PREFIXES[kind]}_[a-z0-9][a-z0-9-]{0,62}$`), `expected a ${kind} ID (${REGISTRY_ID_PREFIXES[kind]}_…)`)
    .brand<K>();
}

/** Identifies a resource in the registry. Each of its releases is versioned separately. */
export const ResourceId = idSchema("resource");
/** A resource identifier. */
export type ResourceId = z.infer<typeof ResourceId>;

/** Identifies a curriculum pack. */
export const CurriculumPackId = idSchema("curriculumPack");
/** A curriculum pack identifier. */
export type CurriculumPackId = z.infer<typeof CurriculumPackId>;

/** Identifies a learning unit. */
export const LearningUnitId = idSchema("learningUnit");
/** A learning unit identifier. */
export type LearningUnitId = z.infer<typeof LearningUnitId>;

/** Identifies an evidence contract. Each of its versions is numbered separately. */
export const EvidenceContractId = idSchema("evidenceContract");
/** An evidence contract identifier. */
export type EvidenceContractId = z.infer<typeof EvidenceContractId>;
