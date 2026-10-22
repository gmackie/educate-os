// Assembles a framework's registry records from rows that each name an item and the groupings
// above it: one `CompetencyNode` per item and per grouping, and one `child-of` association per
// node, up to the framework. Shared by the PlayTrek seed mapping and the publisher-text mappings.
import { SchoolOsError } from "@schoolos/contracts";
import type { CompetencyAssociation, CompetencyNode, FrameworkDefinition, NodeLink, Provenance } from "@schoolos/registry";
import { catalogUuid } from "./digest.ts";

/** One level of a row's hierarchy. */
export interface RecordLevel {
  /** Unique within the framework; the node's URI is built from it. */
  code: string;
  humanCodingScheme?: string;
  itemType: string;
  statement: string;
}

/** What a node says about itself: its notes, extensions and provenance. */
export interface RecordDescription {
  notes: string;
  extensions: NonNullable<CompetencyNode["extensions"]>;
  provenance: Provenance;
}

/** One item and the groupings above it, top first, the item last. */
export interface RecordRow {
  levels: readonly RecordLevel[];
  /** The item's education levels; a grouping carries those of every item under it. */
  educationLevels: readonly string[];
  /** Describes the item. */
  item: RecordDescription;
  /** Describes a grouping this row is the first to name. */
  grouping: RecordDescription;
  /** Where the hierarchy is asserted, recorded as each association's evidence. */
  hierarchySource: string;
}

/** The order education levels are listed in: pre-K, then kindergarten through grade 12. */
const LEVEL_ORDER = ["PK", "KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

/**
 * Builds the nodes and associations for `rows`, in the order rows first name them. A node named by
 * several rows must be given the same statement each time, and an item may appear once; a row may
 * name an earlier row's item as a grouping (a standard above its lettered parts).
 *
 * @throws SchoolOsError `validation-failed` naming `what` if a grouping is given two statements or
 *   an item appears twice.
 */
export async function assembleRecords(
  key: string,
  framework: FrameworkDefinition,
  rows: readonly RecordRow[],
  what: (row: RecordRow) => string,
): Promise<{ nodes: CompetencyNode[]; associations: CompetencyAssociation[] }> {
  const frameworkLink: NodeLink = { title: framework.title, identifier: framework.identifier, uri: framework.uri };
  const uriOf = (code: string) => `urn:schoolos:catalog:${key}:${code}`;

  interface Draft { level: RecordLevel; levels: Set<string>; description: RecordDescription; parent: string | undefined; source: string; isItem: boolean }
  const drafts = new Map<string, Draft>();
  for (const row of rows) {
    for (const [depth, level] of row.levels.entries()) {
      const isItem = depth === row.levels.length - 1;
      const existing = drafts.get(level.code);
      if (existing === undefined) {
        drafts.set(level.code, {
          level,
          levels: new Set(row.educationLevels),
          description: isItem ? row.item : row.grouping,
          parent: row.levels[depth - 1]?.code,
          source: row.hierarchySource,
          isItem,
        });
      } else if ((isItem && existing.isItem) || existing.level.statement !== level.statement) {
        throw new SchoolOsError("validation-failed", `${what(row)} ${isItem ? "appears twice" : `gives ${level.code} a second statement`}`);
      } else {
        for (const l of row.educationLevels) existing.levels.add(l);
      }
    }
  }

  const nodes: CompetencyNode[] = [];
  const associations: CompetencyAssociation[] = [];
  for (const [code, draft] of drafts) {
    const uri = uriOf(code);
    const identifier = await catalogUuid(uri);
    nodes.push({
      uri,
      identifier,
      frameworkLink,
      fullStatement: draft.level.statement,
      ...(draft.level.humanCodingScheme === undefined ? {} : { humanCodingScheme: draft.level.humanCodingScheme }),
      itemType: draft.level.itemType,
      educationLevels: LEVEL_ORDER.filter((l) => draft.levels.has(l)),
      subjects: framework.subjects ?? [],
      language: "en",
      lastChangeDateTime: draft.description.provenance.retrievedAt,
      notes: draft.description.notes,
      extensions: draft.description.extensions,
      provenance: draft.description.provenance,
    });
    const parentUri = draft.parent === undefined ? undefined : uriOf(draft.parent);
    const destination = parentUri === undefined
      ? { ...frameworkLink, targetType: "CFDocument" }
      : { title: drafts.get(draft.parent!)!.level.statement, identifier: await catalogUuid(parentUri), uri: parentUri };
    const associationId = await catalogUuid(`${uri} isChildOf ${destination.uri}`);
    associations.push({
      uri: `urn:schoolos:catalog:${key}:association:${associationId}`,
      identifier: associationId,
      relation: "child-of",
      origin: { title: draft.level.statement, identifier, uri },
      destination,
      frameworkLink,
      lastChangeDateTime: draft.description.provenance.retrievedAt,
      evidence: [{ basis: "publisher-assertion", sourceUri: draft.source }],
      provenance: draft.description.provenance,
    });
  }
  return { nodes, associations };
}
