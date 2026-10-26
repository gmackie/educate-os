// Mapping derived from PlayTrek `packages/edtech/src/case/sync.ts` at commit 7258e4347, which
// copied CASE packages into PlayTrek's database tables. That mapping was lossy on purpose (it
// flattened `educationLevel` to one number, kept only `isChildOf` and `exactMatchOf`, and dropped
// every other field); this codec replaces it with a lossless one and writes to no database.
//
// What the round trip preserves: decoding a CASE 1.1 package and encoding it again yields the same
// JSON value. Every identifier, URI, link title, association type (known or not), education level,
// extension object and rubric is kept verbatim, and an optional field that was absent stays absent.
// Key order and number formatting are not preserved; the round trip is semantic, not byte-exact.
//
// What CASE cannot express, so an encoded package omits it:
// - `provenance` on every record, and `FrameworkDefinition.jurisdiction`. Decoding takes the
//   provenance from the caller instead.
// - Association evidence. Decoding records each CASE association as the publisher's assertion;
//   human reviews and AI similarity scores do not survive an export.
// - The crosswalk relations `close`, `partial`, `broader` and `narrower`. They are written as the
//   CASE 1.1 extension types `ext:educateos.close` and so on, which other CASE consumers will treat
//   as unknown types.
// - Resources, curriculum packs, learning units and evidence contracts, which have no CASE form.
// What EducateOS does not interpret but keeps: CASE rubrics and unknown association types.
import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import {
  type CompetencyAssociation,
  type CompetencyNode,
  type CompetencyRelation,
  type FrameworkDefinition,
  FrameworkRelease,
} from "../framework.ts";
import { Provenance, type ProvenanceAdaptation } from "../primitives.ts";
import { CaseAdaptation } from "./adapter.ts";
import {
  type CaseAssociation,
  type CaseAssociationType,
  type CaseDocument,
  type CaseItem,
  CasePackage,
} from "./wire.ts";

/** How each relation EducateOS interprets is written in CASE. Every other relation is `opaque`. */
const CASE_TYPE_BY_RELATION = {
  "exact": "exactMatchOf",
  "child-of": "isChildOf",
  "peer-of": "isPeerOf",
  "part-of": "isPartOf",
  // CASE `precedes`: the origin comes before the destination in a progression.
  "prerequisite": "precedes",
  "related": "isRelatedTo",
  "replaced-by": "replacedBy",
  "exemplar": "exemplar",
  "has-skill-level": "hasSkillLevel",
  "translation-of": "isTranslationOf",
  "close": "ext:educateos.close",
  "partial": "ext:educateos.partial",
  "broader": "ext:educateos.broader",
  "narrower": "ext:educateos.narrower",
} as const satisfies Record<Exclude<CompetencyRelation, "opaque">, CaseAssociationType | `ext:educateos.${string}`>;

type InterpretedRelation = keyof typeof CASE_TYPE_BY_RELATION;

const RELATION_BY_CASE_TYPE: ReadonlyMap<string, InterpretedRelation> = new Map(
  Object.entries(CASE_TYPE_BY_RELATION).flatMap(([relation, caseType]) => [
    [caseType, relation as InterpretedRelation],
    // Packages written before the EducateOS rename name the extensions `ext:schoolos.*` (SCHO-232). (rename-educateos: keep)
    ...(caseType.startsWith("ext:educateos.") ? [[caseType.replace("ext:educateos.", "ext:schoolos."), relation as InterpretedRelation] as const] : []), // rename-educateos: keep
  ]),
);

// Domain field name -> CASE field name, for the fields that map one to one.
const DOCUMENT_FIELDS = {
  uri: "uri",
  identifier: "identifier",
  title: "title",
  creator: "creator",
  publisher: "publisher",
  description: "description",
  frameworkType: "frameworkType",
  caseVersion: "caseVersion",
  officialSourceUrl: "officialSourceURL",
  packageLink: "CFPackageURI",
  subjects: "subject",
  subjectLinks: "subjectURI",
  language: "language",
  status: "adoptionStatus",
  effectiveFrom: "statusStartDate",
  effectiveUntil: "statusEndDate",
  license: "licenseURI",
  version: "version",
  lastChangeDateTime: "lastChangeDateTime",
  notes: "notes",
  extensions: "extensions",
} as const satisfies Partial<Record<keyof FrameworkDefinition, keyof CaseDocument>>;

const ITEM_FIELDS = {
  uri: "uri",
  identifier: "identifier",
  frameworkLink: "CFDocumentURI",
  fullStatement: "fullStatement",
  alternativeLabel: "alternativeLabel",
  abbreviatedStatement: "abbreviatedStatement",
  humanCodingScheme: "humanCodingScheme",
  listEnumeration: "listEnumeration",
  itemType: "CFItemType",
  itemTypeLink: "CFItemTypeURI",
  conceptKeywords: "conceptKeywords",
  conceptKeywordsLink: "conceptKeywordsURI",
  educationLevels: "educationLevel",
  subjects: "subject",
  subjectLinks: "subjectURI",
  language: "language",
  license: "licenseURI",
  effectiveFrom: "statusStartDate",
  effectiveUntil: "statusEndDate",
  lastChangeDateTime: "lastChangeDateTime",
  notes: "notes",
  extensions: "extensions",
} as const satisfies Partial<Record<keyof CompetencyNode, keyof CaseItem>>;

const ASSOCIATION_FIELDS = {
  uri: "uri",
  identifier: "identifier",
  origin: "originNodeURI",
  destination: "destinationNodeURI",
  sequenceNumber: "sequenceNumber",
  groupingLink: "CFAssociationGroupingURI",
  frameworkLink: "CFDocumentURI",
  lastChangeDateTime: "lastChangeDateTime",
  notes: "notes",
  extensions: "extensions",
} as const satisfies Partial<Record<keyof CompetencyAssociation, keyof CaseAssociation>>;

/** Copies the defined fields of `source` under the names `fields` gives them, so absent stays absent. */
function renameFields(source: object, fields: Readonly<Record<string, string>>, toCase: boolean): Record<string, unknown> {
  const values = source as Readonly<Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [domainKey, caseKey] of Object.entries(fields)) {
    const [from, to] = toCase ? [domainKey, caseKey] : [caseKey, domainKey];
    if (values[from] !== undefined) out[to] = values[from];
  }
  return out;
}

/** Drops keys whose value is `undefined`, so an absent optional field is absent in the output too. */
function compact(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** Strips the domain-only `provenance` from a definition record. */
function withoutProvenance<T extends { provenance: Provenance }>({ provenance: _, ...rest }: T): Omit<T, "provenance"> {
  return rest;
}

/** Parses `value`, turning a failure into a `validation-failed` error that names the failing paths. */
function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new EducateOsError("validation-failed", `invalid ${what}: ${detail}`);
}

/**
 * Groups adaptations by the document or item they changed, as provenance adaptations.
 *
 * @throws EducateOsError `validation-failed` if one targets a listing, or a record the package
 *   does not contain.
 */
function adaptationsByRecord(pkg: CasePackage, adaptations: readonly CaseAdaptation[]): Map<string, ProvenanceAdaptation[]> {
  const records = new Set([`document:${pkg.CFDocument.identifier}`, ...(pkg.CFItems ?? []).map((item) => `item:${item.identifier}`)]);
  const byRecord = new Map<string, ProvenanceAdaptation[]>();
  for (const { target, ...adaptation } of parseOrThrow(z.array(CaseAdaptation), adaptations, "adaptations")) {
    const key = target.kind === "listing" ? undefined : `${target.kind}:${target.identifier}`;
    if (key === undefined || !records.has(key)) {
      throw new EducateOsError("validation-failed", "an adaptation names a record the package does not contain");
    }
    byRecord.set(key, [...(byRecord.get(key) ?? []), adaptation]);
  }
  return byRecord;
}

/**
 * Decodes a CASE 1.1 `CFPackage` into a {@link FrameworkRelease}. Every record gets `provenance`,
 * and every association is recorded as the publisher's assertion.
 *
 * The package must be strict CASE 1.1. A publisher's known deviations are normalized first by a
 * named adapter (`adaptCasePackage`, ADR-0011), whose `adaptations` are passed here and recorded
 * on the provenance of the document or item each one changed.
 *
 * @throws EducateOsError `validation-failed` if the input is not a valid CASE 1.1 package, or an
 *   adaptation names a record it does not contain.
 */
export function decodeCasePackage(
  input: unknown,
  provenance: Provenance,
  adaptations: readonly CaseAdaptation[] = [],
): FrameworkRelease {
  const pkg = parseOrThrow(CasePackage, input, "CASE package");
  const recordProvenance = parseOrThrow(Provenance, provenance, "provenance");
  const adapted = adaptationsByRecord(pkg, adaptations);
  const definitions = pkg.CFDefinitions;
  const withProvenance = <T extends object>(record: T) => ({ ...record, provenance: recordProvenance });
  const provenanceOf = (key: string): Provenance => {
    const changes = adapted.get(key);
    return changes === undefined
      ? recordProvenance
      : { ...recordProvenance, adaptations: [...(recordProvenance.adaptations ?? []), ...changes] };
  };

  return parseOrThrow(FrameworkRelease, compact({
    framework: { ...renameFields(pkg.CFDocument, DOCUMENT_FIELDS, false), provenance: provenanceOf(`document:${pkg.CFDocument.identifier}`) },
    nodes: pkg.CFItems?.map((item) => ({ ...renameFields(item, ITEM_FIELDS, false), provenance: provenanceOf(`item:${item.identifier}`) })),
    associations: pkg.CFAssociations?.map((association) => {
      const relation = RELATION_BY_CASE_TYPE.get(association.associationType);
      return {
        ...renameFields(association, ASSOCIATION_FIELDS, false),
        ...(relation === undefined
          ? { relation: "opaque", opaqueType: association.associationType }
          : { relation }),
        evidence: [{ basis: "publisher-assertion", sourceUri: association.uri }],
        provenance: recordProvenance,
      };
    }),
    definitions: definitions && compact({
      concepts: definitions.CFConcepts?.map(withProvenance),
      subjects: definitions.CFSubjects?.map(withProvenance),
      licenses: definitions.CFLicenses?.map(withProvenance),
      itemTypes: definitions.CFItemTypes?.map(withProvenance),
      associationGroupings: definitions.CFAssociationGroupings?.map(withProvenance),
      extensions: definitions.extensions,
    }),
    caseRubrics: pkg.CFRubrics,
    packageExtensions: pkg.extensions,
  }), "CASE package content");
}

/** The CASE association type a domain association is written as. */
function caseAssociationType(association: CompetencyAssociation): string {
  if (association.relation !== "opaque") return CASE_TYPE_BY_RELATION[association.relation];
  // Decoding never produces an opaque type that names an interpreted relation; refusing one here
  // keeps encode and decode exact inverses.
  if (association.opaqueType === undefined || RELATION_BY_CASE_TYPE.has(association.opaqueType)) {
    throw new EducateOsError(
      "validation-failed",
      `association ${association.uri} has an opaque type that CASE would read as an interpreted relation`,
    );
  }
  return association.opaqueType;
}

/**
 * Encodes a {@link FrameworkRelease} as a CASE 1.1 `CFPackage`. See this module's header for what
 * the CASE form cannot carry.
 *
 * @throws EducateOsError `validation-failed` if the release is invalid.
 */
export function encodeCasePackage(release: FrameworkRelease): CasePackage {
  const valid = parseOrThrow(FrameworkRelease, release, "framework release");
  const definitions = valid.definitions;

  return parseOrThrow(CasePackage, compact({
    CFDocument: renameFields(valid.framework, DOCUMENT_FIELDS, true),
    CFItems: valid.nodes?.map((node) => renameFields(node, ITEM_FIELDS, true)),
    CFAssociations: valid.associations?.map((association) => ({
      ...renameFields(association, ASSOCIATION_FIELDS, true),
      associationType: caseAssociationType(association),
    })),
    CFDefinitions: definitions && compact({
      CFConcepts: definitions.concepts?.map(withoutProvenance),
      CFSubjects: definitions.subjects?.map(withoutProvenance),
      CFLicenses: definitions.licenses?.map(withoutProvenance),
      CFItemTypes: definitions.itemTypes?.map(withoutProvenance),
      CFAssociationGroupings: definitions.associationGroupings?.map(withoutProvenance),
      extensions: definitions.extensions,
    }),
    CFRubrics: valid.caseRubrics,
    extensions: valid.packageExtensions,
  }), "encoded CASE package");
}
