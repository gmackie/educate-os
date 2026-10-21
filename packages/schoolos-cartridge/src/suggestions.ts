import type { CatalogMirror } from "@schoolos/catalog";
import type { CartridgeLink } from "./plan.ts";

/**
 * A catalog item a cartridge's standards claim may mean, offered to a reviewer. It is a suggestion
 * only: CASE item identifiers are UUIDs and other providers use UUIDs too, so a match is evidence,
 * not proof. Nothing turns a suggestion into an alignment except a reviewer naming it when they
 * approve the resource.
 */
export interface AlignmentSuggestion {
  linkId: string;
  /** The GUID the cartridge claimed, as written. */
  guid: string;
  /** The cartridge's label for the claim, if it gave one. */
  claimedLabel: string | undefined;
  /** The catalog framework and item the GUID names in the district's approved release. */
  frameworkKey: string;
  competencyUri: string;
  humanCodingScheme: string | undefined;
  fullStatement: string;
  basis: "case-item-guid";
}

/**
 * Suggests catalog items for the CASE-shaped GUIDs a cartridge's links claim, looking only in the
 * framework releases the district approved: never a proposed or retired release, and never a
 * framework the district did not select.
 */
export async function suggestCaseAlignments(links: readonly CartridgeLink[], mirror: CatalogMirror): Promise<AlignmentSuggestion[]> {
  const byIdentifier = new Map<string, { frameworkKey: string; competencyUri: string; humanCodingScheme: string | undefined; fullStatement: string }[]>();
  for (const state of await mirror.selections()) {
    const release = state.releases.find((installed) => installed.status === "approved")?.release;
    for (const node of release?.content.nodes ?? []) {
      const key = node.identifier.toLowerCase();
      const entry = { frameworkKey: state.frameworkKey, competencyUri: node.uri, humanCodingScheme: node.humanCodingScheme, fullStatement: node.fullStatement };
      byIdentifier.set(key, [...(byIdentifier.get(key) ?? []), entry]);
    }
  }
  const suggestions: AlignmentSuggestion[] = [];
  for (const link of links) {
    for (const claim of link.metadata.standards) {
      if (claim.caseItemGuid === undefined) continue;
      for (const match of byIdentifier.get(claim.caseItemGuid) ?? []) {
        suggestions.push({ linkId: link.id, guid: claim.guid, claimedLabel: claim.label, ...match, basis: "case-item-guid" });
      }
    }
  }
  return suggestions;
}
