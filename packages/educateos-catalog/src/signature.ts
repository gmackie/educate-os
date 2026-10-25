// Catalog release signatures, wired to the release-signing trust of `@educateos/releases` (roadmap
// R03, SCHO-64). The root signs a catalog release with the same online release keys it signs
// manifests with, under its own message kind, and a district verifies it against the release keys it
// already pins. The offline root keys only sign release key sets, so they never sign a catalog.
import { SignedEnvelope, type SigningIdentity } from "@educateos/fleet";
import { ImmutableRelease } from "@educateos/registry";
import { openReleaseMessage, type ReleaseTrust, signReleaseMessage } from "@educateos/releases";
import { z } from "zod";
import type { VerifyRelease } from "./mirror.ts";
import type { CatalogRelease } from "./release.ts";
import { CatalogKey } from "./vocabulary.ts";

/**
 * What a catalog release signature covers. The content is bound through `contentDigest`; the
 * mirror refuses content that does not match it before it checks the signature.
 */
export const CatalogReleaseStatement = z.strictObject({
  frameworkKey: CatalogKey,
  ...ImmutableRelease.shape,
});
/** A catalog release statement. */
export type CatalogReleaseStatement = z.infer<typeof CatalogReleaseStatement>;

const statementOf = (release: CatalogRelease): CatalogReleaseStatement => ({
  frameworkKey: release.frameworkKey,
  version: release.version,
  releasedAt: release.releasedAt,
  contentDigest: release.contentDigest,
});

/** Signs a catalog release with a release key, returning the release with its signature. */
export async function signCatalogRelease(identity: SigningIdentity, release: CatalogRelease): Promise<CatalogRelease> {
  const envelope = await signReleaseMessage(identity, "catalog-release", CatalogReleaseStatement.parse(statementOf(release)));
  return { ...release, signature: { keyId: envelope.keyId, signature: envelope.signature } };
}

/** What {@link catalogReleaseVerifier} checks signatures against. */
export interface CatalogReleaseVerifierOptions {
  /** The district's pinned release trust now; an accepted release key set changes it, so it is read per check. */
  trust: () => Promise<ReleaseTrust>;
  now: () => Date;
}

/**
 * The mirror's `verifyRelease` hook: accepts a release only if a release key the district trusts
 * at `now` signed its statement as a `catalog-release`. An unsigned release, a malformed
 * key ID or signature, an unknown or retired key, or a signature over any other statement (another
 * version, another digest, or a release manifest) is refused.
 */
export function catalogReleaseVerifier(options: CatalogReleaseVerifierOptions): VerifyRelease {
  return async (release) => {
    if (release.signature === undefined) return false;
    const envelope = SignedEnvelope.safeParse({ payload: statementOf(release), ...release.signature });
    if (!envelope.success) return false;
    const opened = await openReleaseMessage(envelope.data, "catalog-release", CatalogReleaseStatement, await options.trust(), options.now());
    return opened !== undefined;
  };
}
