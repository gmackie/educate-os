// Extracted from PlayTrek `packages/edtech/src/case/types.ts` at commit 7258e4347, then rewritten
// as Zod schemas and corrected against the 1EdTech CASE 1.1 REST/JSON binding. PlayTrek's
// interfaces used `id` and `subjects` where the wire format says `identifier` and `subject`,
// declared a non-standard `CFItem.parentURI`, and closed the association vocabulary; see
// `playtrek-compat.ts` for reading data in PlayTrek's declared shape.
import { z } from "zod";
import { RegistryIdentifier } from "../framework.ts";
import { LanguageTag, OpaqueJsonObject, RegistryDate, RegistryDateTime, RegistryUri } from "../primitives.ts";

/**
 * The association types CASE 1.1 defines. CASE 1.1 makes the vocabulary extensible (by
 * convention with an `ext:` prefix, though published data also uses bare names), so a CASE
 * association may carry any other type too.
 */
export const CASE_ASSOCIATION_TYPES = [
  "isChildOf",
  "isPeerOf",
  "isPartOf",
  "exactMatchOf",
  "precedes",
  "isRelatedTo",
  "replacedBy",
  "exemplar",
  "hasSkillLevel",
  "isTranslationOf",
] as const;

/** One of {@link CASE_ASSOCIATION_TYPES}. */
export type CaseAssociationType = (typeof CASE_ASSOCIATION_TYPES)[number];

/** CASE `LinkURI`: a reference to another CASE object. */
export const CaseLinkUri = z.strictObject({
  title: z.string(),
  identifier: z.string().min(1).max(200),
  uri: RegistryUri,
});
/** A CASE `LinkURI`. */
export type CaseLinkUri = z.infer<typeof CaseLinkUri>;

/** CASE `LinkGenURI`: a `LinkURI` that may name its target's type (added in CASE 1.1). */
export const CaseLinkGenUri = z.strictObject({
  ...CaseLinkUri.shape,
  targetType: z.string().min(1).max(200).optional(),
});
/** A CASE `LinkGenURI`. */
export type CaseLinkGenUri = z.infer<typeof CaseLinkGenUri>;

/**
 * CASE `CFDocument`. `CFPackageURI` is required on a standalone document and absent from the
 * package form (`CFPckgDocument`); publishers include it in packages too, so it is optional here.
 */
export const CaseDocument = z.strictObject({
  identifier: RegistryIdentifier,
  uri: RegistryUri,
  CFPackageURI: CaseLinkUri.optional(),
  creator: z.string(),
  title: z.string(),
  lastChangeDateTime: RegistryDateTime,
  frameworkType: z.string().optional(),
  caseVersion: z.string().optional(),
  officialSourceURL: RegistryUri.optional(),
  publisher: z.string().optional(),
  description: z.string().optional(),
  subject: z.array(z.string()).optional(),
  subjectURI: z.array(CaseLinkUri).optional(),
  language: LanguageTag.optional(),
  version: z.string().optional(),
  adoptionStatus: z.string().optional(),
  statusStartDate: RegistryDate.optional(),
  statusEndDate: RegistryDate.optional(),
  licenseURI: CaseLinkUri.optional(),
  notes: z.string().optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A CASE `CFDocument`. */
export type CaseDocument = z.infer<typeof CaseDocument>;

/**
 * CASE `CFItem`. `CFDocumentURI` is required on a standalone item and absent from the package form
 * (`CFPckgItem`), so it is optional here.
 */
export const CaseItem = z.strictObject({
  identifier: RegistryIdentifier,
  uri: RegistryUri,
  CFDocumentURI: CaseLinkUri.optional(),
  fullStatement: z.string(),
  lastChangeDateTime: RegistryDateTime,
  alternativeLabel: z.string().optional(),
  CFItemType: z.string().optional(),
  humanCodingScheme: z.string().optional(),
  listEnumeration: z.string().optional(),
  abbreviatedStatement: z.string().optional(),
  conceptKeywords: z.array(z.string()).optional(),
  conceptKeywordsURI: CaseLinkUri.optional(),
  notes: z.string().optional(),
  subject: z.array(z.string()).optional(),
  subjectURI: z.array(CaseLinkUri).optional(),
  language: LanguageTag.optional(),
  educationLevel: z.array(z.string().min(1)).optional(),
  CFItemTypeURI: CaseLinkUri.optional(),
  licenseURI: CaseLinkUri.optional(),
  statusStartDate: RegistryDate.optional(),
  statusEndDate: RegistryDate.optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A CASE `CFItem`. */
export type CaseItem = z.infer<typeof CaseItem>;

/** CASE `CFAssociation`. The association type is any non-empty name (see {@link CASE_ASSOCIATION_TYPES}). */
export const CaseAssociation = z.strictObject({
  identifier: RegistryIdentifier,
  uri: RegistryUri,
  associationType: z.string().min(1).max(200),
  originNodeURI: CaseLinkGenUri,
  destinationNodeURI: CaseLinkGenUri,
  lastChangeDateTime: RegistryDateTime,
  CFDocumentURI: CaseLinkUri.optional(),
  sequenceNumber: z.number().int().optional(),
  CFAssociationGroupingURI: CaseLinkUri.optional(),
  notes: z.string().optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A CASE `CFAssociation`. */
export type CaseAssociation = z.infer<typeof CaseAssociation>;

const caseDefinitionBase = {
  identifier: RegistryIdentifier,
  uri: RegistryUri,
  title: z.string(),
  lastChangeDateTime: RegistryDateTime,
  extensions: OpaqueJsonObject.optional(),
};

/** CASE `CFConcept`. */
export const CaseConcept = z.strictObject({
  ...caseDefinitionBase,
  hierarchyCode: z.string(),
  keywords: z.string().optional(),
  description: z.string().optional(),
});
/** A CASE `CFConcept`. */
export type CaseConcept = z.infer<typeof CaseConcept>;

/** CASE `CFSubject`. */
export const CaseSubject = z.strictObject({
  ...caseDefinitionBase,
  hierarchyCode: z.string(),
  description: z.string().optional(),
});
/** A CASE `CFSubject`. */
export type CaseSubject = z.infer<typeof CaseSubject>;

/** CASE `CFLicense`. */
export const CaseLicense = z.strictObject({
  ...caseDefinitionBase,
  licenseText: z.string(),
  description: z.string().optional(),
});
/** A CASE `CFLicense`. */
export type CaseLicense = z.infer<typeof CaseLicense>;

/** CASE `CFItemType`. */
export const CaseItemType = z.strictObject({
  ...caseDefinitionBase,
  description: z.string(),
  hierarchyCode: z.string(),
  typeCode: z.string().optional(),
});
/** A CASE `CFItemType`. */
export type CaseItemType = z.infer<typeof CaseItemType>;

/** CASE `CFAssociationGrouping`. */
export const CaseAssociationGrouping = z.strictObject({
  ...caseDefinitionBase,
  description: z.string().optional(),
});
/** A CASE `CFAssociationGrouping`. */
export type CaseAssociationGrouping = z.infer<typeof CaseAssociationGrouping>;

/** CASE `CFDefinitions`. */
export const CaseDefinitions = z.strictObject({
  CFConcepts: z.array(CaseConcept).optional(),
  CFSubjects: z.array(CaseSubject).optional(),
  CFLicenses: z.array(CaseLicense).optional(),
  CFItemTypes: z.array(CaseItemType).optional(),
  CFAssociationGroupings: z.array(CaseAssociationGrouping).optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A CASE `CFDefinitions`. */
export type CaseDefinitions = z.infer<typeof CaseDefinitions>;

/**
 * CASE `CFPackage`: one framework document with its items, associations and definitions.
 * Unknown top-level fields are rejected; CASE 1.1 puts proprietary data in `extensions`.
 */
export const CasePackage = z.strictObject({
  CFDocument: CaseDocument,
  CFItems: z.array(CaseItem).optional(),
  CFAssociations: z.array(CaseAssociation).optional(),
  CFDefinitions: CaseDefinitions.optional(),
  /** Rubrics are carried as opaque objects; see `FrameworkRelease.caseRubrics`. */
  CFRubrics: z.array(OpaqueJsonObject).optional(),
  extensions: OpaqueJsonObject.optional(),
});
/** A CASE `CFPackage`. */
export type CasePackage = z.infer<typeof CasePackage>;

/** The response of `GET /CFDocuments`. */
export const CaseDocumentSet = z.strictObject({ CFDocuments: z.array(CaseDocument) });
/** A CASE `CFDocumentSet`. */
export type CaseDocumentSet = z.infer<typeof CaseDocumentSet>;

/** The response of `GET /CFItemAssociations/{id}`: an item and every association it takes part in. */
export const CaseAssociationSet = z.strictObject({
  CFItem: CaseItem,
  CFAssociations: z.array(CaseAssociation),
});
/** A CASE `CFAssociationSet`. */
export type CaseAssociationSet = z.infer<typeof CaseAssociationSet>;
