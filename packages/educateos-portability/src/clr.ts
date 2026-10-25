import { EducateOsError } from "@educateos/contracts";
import type { SubjectRef } from "./archive.ts";
import type { ValidatedArchive } from "./validate.ts";

/**
 * The seam for 1EdTech Comprehensive Learner Record (CLR) 2.0 exports. Nothing implements it yet,
 * on purpose. A CLR 2.0 credential is a verifiable credential the district signs as issuer, so
 * issuing one needs:
 *
 * - issuer signing keys the district holds and publishes, with rotation and revocation;
 * - a district decision about which records are achievements it will assert, under which
 *   achievement definitions, and for whom;
 * - the learner's identifier in the credential, which must not be the district principal ID.
 *
 * Until a district has made those decisions, EducateOS issues no CLR and never invents a credential
 * from an archive's contents. See `docs/educateos/educateos-archive-format.md`.
 */
export interface ClrIssuer {
  /**
   * Issues a signed CLR 2.0 credential about `subject` for the achievements in `archive` the
   * district has decided to assert.
   */
  issue(archive: ValidatedArchive, subject: SubjectRef): Promise<SignedClrCredential>;
}

/** A signed CLR 2.0 credential as an issuer returns it. */
export interface SignedClrCredential {
  /** `application/vc+jwt` for a JWT-secured credential, `application/vc+ld+json` for an embedded proof. */
  mediaType: "application/vc+jwt" | "application/vc+ld+json";
  bytes: Uint8Array<ArrayBuffer>;
}

/** The issuer every district has until it configures one: it refuses with `unavailable`. */
export const UNCONFIGURED_CLR_ISSUER: ClrIssuer = {
  async issue() {
    throw new EducateOsError(
      "unavailable",
      "Comprehensive Learner Record export is not available: the district has not configured a credential issuer.",
    );
  },
};
