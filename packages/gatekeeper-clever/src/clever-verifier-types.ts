import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";

/**
 * The non-standard method the Clever gatekeepers call on their own verifier (see their
 * addObserver). Not part of the generic GatekeeperUserVerifier contract; the overseer only ever
 * hands a Clever verifier back to a Clever gatekeeper, which may therefore trust its answers.
 */
export interface CleverVerifierApi extends GatekeeperUserVerifier {
  /**
   * Whether the verifier's user teaches each section, by the district's own records: one verdict
   * per ID, in order. A section of another district, or none at all, is `false`.
   */
  teachesSections(sectionIds: string[]): Promise<boolean[]>;
}
