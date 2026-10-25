// Extracted from PlayTrek `packages/edtech/src/case/types.ts` at commit 7258e4347: the CASE shapes
// exactly as PlayTrek declares them, as Zod schemas, with conversions to and from CASE 1.1.
//
// PlayTrek's declared shape differs from the CASE wire format: `id` for `identifier`, `subjects`
// for `subject`, a required `CFItem.parentURI` that CASE expresses as an `isChildOf` association,
// a closed list of seven association types, and several optional CASE fields made required. Data
// in that shape converts to CASE 1.1 (and from there to registry records) with no PlayTrek
// database. A conversion either preserves everything or fails; it never fills in or drops a value.
import { EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import { RegistryDateTime, RegistryUri } from "../primitives.ts";
import { type CaseAssociation, CaseLinkUri, CasePackage } from "./wire.ts";

/** The association types PlayTrek's `CFAssociationType` allows. */
export const PLAYTREK_ASSOCIATION_TYPES = [
  "exactMatchOf",
  "isChildOf",
  "isPartOf",
  "replacedBy",
  "precedes",
  "isRelatedTo",
  "isPeerOf",
] as const;

/** PlayTrek's `CFDocument`. */
export const PlayTrekCfDocument = z.strictObject({
  id: z.string().min(1),
  uri: RegistryUri,
  title: z.string(),
  creator: z.string(),
  description: z.string(),
  subjects: z.array(z.string()),
  lastChangeDateTime: RegistryDateTime,
  officialSourceURL: RegistryUri,
  CFPackageURI: CaseLinkUri,
});

/** PlayTrek's `CFItem`. */
export const PlayTrekCfItem = z.strictObject({
  id: z.string().min(1),
  uri: RegistryUri,
  fullStatement: z.string(),
  humanCodingScheme: z.string(),
  CFDocumentURI: CaseLinkUri,
  CFItemType: z.string(),
  educationLevel: z.array(z.string().min(1)),
  lastChangeDateTime: RegistryDateTime,
  parentURI: CaseLinkUri,
  listEnumeration: z.string(),
});

/** PlayTrek's `CFAssociation`. */
export const PlayTrekCfAssociation = z.strictObject({
  id: z.string().min(1),
  uri: RegistryUri,
  associationType: z.enum(PLAYTREK_ASSOCIATION_TYPES),
  originNodeURI: CaseLinkUri,
  destinationNodeURI: CaseLinkUri,
  lastChangeDateTime: RegistryDateTime,
});

/** PlayTrek's `CFPackage`. */
export const PlayTrekCfPackage = z.strictObject({
  CFDocument: PlayTrekCfDocument,
  CFItems: z.array(PlayTrekCfItem),
  CFAssociations: z.array(PlayTrekCfAssociation),
});
/** A CASE package in PlayTrek's declared shape. */
export type PlayTrekCfPackage = z.infer<typeof PlayTrekCfPackage>;

/** A `LinkGenURI` as a plain `LinkURI`; PlayTrek's links have no `targetType`. */
function withoutTargetType({ targetType: _, ...link }: CaseAssociation["originNodeURI"]): CaseLinkUri {
  return link;
}

function sameLink(a: CaseLinkUri, b: CaseLinkUri): boolean {
  return a.title === b.title && a.identifier === b.identifier && a.uri === b.uri;
}

function invalid(message: string): EducateOsError {
  return new EducateOsError("validation-failed", message);
}

/**
 * Converts a package in PlayTrek's shape to CASE 1.1. Each item's `parentURI` must match an
 * `isChildOf` association from that item, since CASE has no other place to keep it and inventing
 * an association would mint identifiers the publisher never issued.
 *
 * @throws EducateOsError `validation-failed` if the input is invalid or a parent is not backed by
 *   an association.
 */
export function playTrekToCasePackage(input: unknown): CasePackage {
  const parsed = PlayTrekCfPackage.safeParse(input);
  if (!parsed.success) throw invalid("not a PlayTrek-shaped CASE package");
  const { CFDocument: document, CFItems: items, CFAssociations: associations } = parsed.data;

  for (const item of items) {
    const backed = associations.some((a) =>
      a.associationType === "isChildOf" && a.originNodeURI.uri === item.uri && sameLink(a.destinationNodeURI, item.parentURI)
    );
    if (!backed) throw invalid(`item ${item.uri} has a parentURI with no matching isChildOf association`);
  }

  const result = CasePackage.safeParse({
    CFDocument: {
      identifier: document.id,
      uri: document.uri,
      CFPackageURI: document.CFPackageURI,
      creator: document.creator,
      title: document.title,
      lastChangeDateTime: document.lastChangeDateTime,
      officialSourceURL: document.officialSourceURL,
      description: document.description,
      subject: document.subjects,
    },
    CFItems: items.map(({ id, parentURI: _, ...item }) => ({ identifier: id, ...item })),
    CFAssociations: associations.map(({ id, ...association }) => ({ identifier: id, ...association })),
  });
  if (!result.success) throw invalid("PlayTrek-shaped package does not convert to valid CASE 1.1");
  return result.data;
}

/**
 * Converts a CASE 1.1 package to PlayTrek's shape, for handing EducateOS registry data back to
 * PlayTrek. Fails rather than drop anything PlayTrek's shape cannot hold, such as an extension, a
 * definition, an `ext:` association type or an item with two parents.
 *
 * @throws EducateOsError `validation-failed` if the package cannot be expressed without loss.
 */
export function caseToPlayTrekPackage(pkg: CasePackage): PlayTrekCfPackage {
  const { CFDocument: document, CFItems: items = [], CFAssociations: associations = [] } = pkg;
  const parentOf = (itemUri: string): CaseLinkUri => {
    const parents = associations.filter((a) => a.associationType === "isChildOf" && a.originNodeURI.uri === itemUri);
    if (parents.length !== 1) throw invalid(`item ${itemUri} needs exactly one isChildOf parent for PlayTrek`);
    return withoutTargetType(parents[0].destinationNodeURI);
  };

  const result = PlayTrekCfPackage.safeParse({
    CFDocument: {
      id: document.identifier,
      uri: document.uri,
      title: document.title,
      creator: document.creator,
      description: document.description,
      subjects: document.subject,
      lastChangeDateTime: document.lastChangeDateTime,
      officialSourceURL: document.officialSourceURL,
      CFPackageURI: document.CFPackageURI,
    },
    CFItems: items.map((item) => ({
      id: item.identifier,
      uri: item.uri,
      fullStatement: item.fullStatement,
      humanCodingScheme: item.humanCodingScheme,
      CFDocumentURI: item.CFDocumentURI,
      CFItemType: item.CFItemType,
      educationLevel: item.educationLevel,
      lastChangeDateTime: item.lastChangeDateTime,
      parentURI: parentOf(item.uri),
      listEnumeration: item.listEnumeration,
    })),
    CFAssociations: associations.map((association) => ({
      id: association.identifier,
      uri: association.uri,
      associationType: association.associationType,
      originNodeURI: withoutTargetType(association.originNodeURI),
      destinationNodeURI: withoutTargetType(association.destinationNodeURI),
      lastChangeDateTime: association.lastChangeDateTime,
    })),
  });
  if (!result.success) throw invalid("CASE package uses fields or values PlayTrek's shape cannot hold");

  // Anything PlayTrek's shape could not carry shows up as a difference after converting back.
  if (canonicalJson(playTrekToCasePackage(result.data)) !== canonicalJson(pkg)) {
    throw invalid("CASE package uses fields or values PlayTrek's shape cannot hold");
  }
  return result.data;
}

/** JSON with object keys sorted, so two values compare equal regardless of key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v);
}
