import { RightsMode } from "@educateos/registry";
import type { LicenseEvidence } from "./license.ts";

/**
 * Rights modes from narrowest to widest: link to the source, embed it unchanged, quote a
 * permitted excerpt (the registry's `excerpt`), hold a licensed copy. Each mode permits
 * everything narrower than it.
 */
export const RIGHTS_ORDER: readonly RightsMode[] = RightsMode.options;

/** The rights modes `mode` permits: itself and every narrower mode. */
export function permittedUses(mode: RightsMode): RightsMode[] {
  return RIGHTS_ORDER.slice(0, RIGHTS_ORDER.indexOf(mode) + 1);
}

/** Whether moving from `from` to `to` widens what EducateOS may do with a resource. */
export function widens(from: RightsMode, to: RightsMode): boolean {
  return RIGHTS_ORDER.indexOf(to) > RIGHTS_ORDER.indexOf(from);
}

/**
 * The rights mode the importer proposes from a source's license evidence. Anything short of one
 * recognized license (absent, unrecognized or conflicting evidence) proposes `link` only, and so
 * does every upload, whose license nobody has stated.
 */
export function proposeRightsMode(evidence: LicenseEvidence): RightsMode {
  return evidence.status === "recognized" ? evidence.license.supports : "link";
}
