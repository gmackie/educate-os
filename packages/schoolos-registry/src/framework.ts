import { z } from "zod";
import {
  HumanReview,
  LanguageTag,
  NodeLink,
  OpaqueJsonObject,
  Provenance,
  RegistryDate,
  RegistryDateTime,
  RegistryUri,
  TypedNodeLink,
} from "./primitives.ts";

/**
 * A framework or node identifier: a UUID in any letter case (CASE `UUID`), kept as written so it
 * still matches the publisher's own records.
 */
export const RegistryIdentifier = z.guid();
/** A framework or node identifier. */
export type RegistryIdentifier = z.infer<typeof RegistryIdentifier>;

/**
 * A competency framework: one published set of standards or competencies, such as a state's
 * science standards or a district's own framework. Imported from a CASE `CFDocument`.
 */
export const FrameworkDefinition = z.strictObject({
  /** The stable publisher or CASE URI. The registry's key for the framework. */
  uri: RegistryUri,
  /** The CASE `CFDocument` identifier. */
  identifier: RegistryIdentifier,
  title: z.string(),
  creator: z.string(),
  publisher: z.string().optional(),
  description: z.string().optional(),
  /** The CASE `frameworkType`, such as `Standards` or `Competencies`. */
  frameworkType: z.string().optional(),
  /** The CASE version the framework was published under, such as `1.1`. */
  caseVersion: z.string().optional(),
  officialSourceUrl: RegistryUri.optional(),
  /** The publisher's link to its CASE package, when it gave one. */
  packageLink: NodeLink.optional(),
  subjects: z.array(z.string()).optional(),
  subjectLinks: z.array(NodeLink).optional(),
  language: LanguageTag.optional(),
  /**
   * Where the framework applies, such as a state. CASE has no field for this, so it is set only by
   * district or reviewer input and is not written to CASE exports.
   */
  jurisdiction: z.string().min(1).max(200).optional(),
  /** The publisher's adoption status, such as `Draft`, `Adopted` or `Deprecated`, as published. */
  status: z.string().optional(),
  effectiveFrom: RegistryDate.optional(),
  effectiveUntil: RegistryDate.optional(),
  license: NodeLink.optional(),
  /** The publisher's version label. Together with `lastChangeDateTime` it identifies a revision. */
  version: z.string().optional(),
  lastChangeDateTime: RegistryDateTime,
  notes: z.string().optional(),
  extensions: OpaqueJsonObject.optional(),
  provenance: Provenance,
});
/** A competency framework. */
export type FrameworkDefinition = z.infer<typeof FrameworkDefinition>;

/**
 * One competency, standard or grouping within a framework: a CASE `CFItem`.
 *
 * Education levels are kept exactly as published. A composite band such as `9-12` stays one
 * entry, and a list of grades stays a list; neither is flattened to a single numeric grade, since
 * that would claim a precision the publisher never gave.
 */
export const CompetencyNode = z.strictObject({
  uri: RegistryUri,
  identifier: RegistryIdentifier,
  /** The framework the node belongs to, when the source named it on the node itself. */
  frameworkLink: NodeLink.optional(),
  fullStatement: z.string(),
  alternativeLabel: z.string().optional(),
  abbreviatedStatement: z.string().optional(),
  /** The publisher's code, such as `SCI.7.2`. */
  humanCodingScheme: z.string().optional(),
  listEnumeration: z.string().optional(),
  /** The publisher's item type label, such as `Standard` or `Cluster`. */
  itemType: z.string().optional(),
  itemTypeLink: NodeLink.optional(),
  conceptKeywords: z.array(z.string()).optional(),
  conceptKeywordsLink: NodeLink.optional(),
  educationLevels: z.array(z.string().min(1)).optional(),
  subjects: z.array(z.string()).optional(),
  subjectLinks: z.array(NodeLink).optional(),
  language: LanguageTag.optional(),
  license: NodeLink.optional(),
  effectiveFrom: RegistryDate.optional(),
  effectiveUntil: RegistryDate.optional(),
  lastChangeDateTime: RegistryDateTime,
  notes: z.string().optional(),
  extensions: OpaqueJsonObject.optional(),
  provenance: Provenance,
});
/** A competency node. */
export type CompetencyNode = z.infer<typeof CompetencyNode>;

/**
 * How an association's origin relates to its destination.
 *
 * - `exact`: the two express the same expectation. Requires review evidence (see
 *   {@link CompetencyAssociation}).
 * - `close`, `partial`, `broader`, `narrower`: crosswalk judgements weaker than `exact`.
 * - `prerequisite`: the origin should be learned before the destination (CASE `precedes`).
 * - `replaced-by`: the destination supersedes the origin.
 * - `child-of`, `part-of`, `peer-of`, `related`, `exemplar`, `has-skill-level`,
 *   `translation-of`: the remaining CASE 1.1 association types.
 * - `opaque`: a type SchoolOS does not interpret, such as a publisher's `ext:` type. Its name is
 *   kept verbatim in `opaqueType` and written back unchanged.
 */
export const CompetencyRelation = z.enum([
  "exact",
  "close",
  "partial",
  "broader",
  "narrower",
  "prerequisite",
  "replaced-by",
  "child-of",
  "part-of",
  "peer-of",
  "related",
  "exemplar",
  "has-skill-level",
  "translation-of",
  "opaque",
]);
/** A competency relation. */
export type CompetencyRelation = z.infer<typeof CompetencyRelation>;

/**
 * Why the registry believes an association holds.
 *
 * - `publisher-assertion`: the publisher stated it in its own release, at `sourceUri`.
 * - `human-review`: a named SchoolOS principal reviewed and accepted it.
 * - `ai-similarity`: a model judged the two similar. This never establishes `exact`.
 */
export const AssociationEvidence = z.discriminatedUnion("basis", [
  z.strictObject({ basis: z.literal("publisher-assertion"), sourceUri: RegistryUri }),
  z.strictObject({ basis: z.literal("human-review"), ...HumanReview.shape, note: z.string().max(2000).optional() }),
  z.strictObject({
    basis: z.literal("ai-similarity"),
    model: z.string().min(1).max(200),
    score: z.number().min(0).max(1),
  }),
]);
/** Evidence for an association. */
export type AssociationEvidence = z.infer<typeof AssociationEvidence>;

/** The evidence bases that count as review, and so can support an `exact` relation. */
const REVIEW_BASES: ReadonlySet<AssociationEvidence["basis"]> = new Set(["publisher-assertion", "human-review"]);

/**
 * A relationship between two nodes: a CASE `CFAssociation`, or a crosswalk SchoolOS recorded.
 *
 * An `exact` association must carry review evidence: a publisher's assertion or a named
 * reviewer's acceptance. AI similarity alone can suggest `close` or weaker, so a model can never
 * manufacture an exact equivalence.
 */
export const CompetencyAssociation = z
  .strictObject({
    uri: RegistryUri,
    identifier: RegistryIdentifier,
    relation: CompetencyRelation,
    /** The verbatim association type when `relation` is `opaque`; absent otherwise. */
    opaqueType: z.string().min(1).max(200).optional(),
    origin: TypedNodeLink,
    destination: TypedNodeLink,
    sequenceNumber: z.number().int().optional(),
    groupingLink: NodeLink.optional(),
    frameworkLink: NodeLink.optional(),
    lastChangeDateTime: RegistryDateTime,
    notes: z.string().optional(),
    extensions: OpaqueJsonObject.optional(),
    evidence: z.array(AssociationEvidence).min(1),
    provenance: Provenance,
  })
  .superRefine((association, ctx) => {
    if ((association.relation === "opaque") !== (association.opaqueType !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["opaqueType"],
        message: "opaqueType is required for an opaque relation and forbidden otherwise",
      });
    }
    if (association.relation === "exact" && !association.evidence.some((e) => REVIEW_BASES.has(e.basis))) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "an exact association needs a publisher assertion or a human review",
      });
    }
  });
/** A competency association. */
export type CompetencyAssociation = z.infer<typeof CompetencyAssociation>;

const definitionBase = {
  uri: RegistryUri,
  identifier: RegistryIdentifier,
  title: z.string(),
  lastChangeDateTime: RegistryDateTime,
  extensions: OpaqueJsonObject.optional(),
  provenance: Provenance,
};

/** A concept a framework's items are tagged with: CASE `CFConcept`. */
export const ConceptDefinition = z.strictObject({
  ...definitionBase,
  hierarchyCode: z.string(),
  keywords: z.string().optional(),
  description: z.string().optional(),
});
/** A concept definition. */
export type ConceptDefinition = z.infer<typeof ConceptDefinition>;

/** A subject a framework or item covers: CASE `CFSubject`. */
export const SubjectDefinition = z.strictObject({
  ...definitionBase,
  hierarchyCode: z.string(),
  description: z.string().optional(),
});
/** A subject definition. */
export type SubjectDefinition = z.infer<typeof SubjectDefinition>;

/** A license the publisher released content under: CASE `CFLicense`. */
export const LicenseDefinition = z.strictObject({
  ...definitionBase,
  licenseText: z.string(),
  description: z.string().optional(),
});
/** A license definition. */
export type LicenseDefinition = z.infer<typeof LicenseDefinition>;

/** A kind of item, such as `Standard` or `Cluster`: CASE `CFItemType`. */
export const ItemTypeDefinition = z.strictObject({
  ...definitionBase,
  description: z.string(),
  hierarchyCode: z.string(),
  typeCode: z.string().optional(),
});
/** An item type definition. */
export type ItemTypeDefinition = z.infer<typeof ItemTypeDefinition>;

/** A named group of associations, such as one crosswalk: CASE `CFAssociationGrouping`. */
export const AssociationGroupingDefinition = z.strictObject({
  ...definitionBase,
  description: z.string().optional(),
});
/** An association grouping definition. */
export type AssociationGroupingDefinition = z.infer<typeof AssociationGroupingDefinition>;

/** The vocabularies a framework release defines: CASE `CFDefinitions`. */
export const FrameworkDefinitions = z.strictObject({
  concepts: z.array(ConceptDefinition).optional(),
  subjects: z.array(SubjectDefinition).optional(),
  licenses: z.array(LicenseDefinition).optional(),
  itemTypes: z.array(ItemTypeDefinition).optional(),
  associationGroupings: z.array(AssociationGroupingDefinition).optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A framework release's definitions. */
export type FrameworkDefinitions = z.infer<typeof FrameworkDefinitions>;

/**
 * One release of a framework with everything published alongside it: a CASE `CFPackage`.
 *
 * Every node URI is unique within the release, as is every association URI.
 */
export const FrameworkRelease = z
  .strictObject({
    framework: FrameworkDefinition,
    nodes: z.array(CompetencyNode).optional(),
    associations: z.array(CompetencyAssociation).optional(),
    definitions: FrameworkDefinitions.optional(),
    /**
     * CASE rubrics, carried verbatim. SchoolOS assessment uses its own evidence contracts and does
     * not interpret CASE rubrics, but keeps them so a re-export loses nothing.
     */
    caseRubrics: z.array(OpaqueJsonObject).optional(),
    /** The CASE package's own `extensions`, carried verbatim. */
    packageExtensions: OpaqueJsonObject.optional(),
  })
  .superRefine((release, ctx) => {
    for (const [key, records] of [["nodes", release.nodes], ["associations", release.associations]] as const) {
      const seen = new Set<string>();
      for (const [index, record] of (records ?? []).entries()) {
        if (seen.has(record.uri)) {
          ctx.addIssue({ code: "custom", path: [key, index, "uri"], message: `duplicate URI ${record.uri}` });
        }
        seen.add(record.uri);
      }
    }
  });
/** A framework release. */
export type FrameworkRelease = z.infer<typeof FrameworkRelease>;
