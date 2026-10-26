// Publisher signatures on OCS packages (RFC 0001 §12 Q4, SCHO-96). Built on the R03 primitives: the
// fleet's Ed25519 identities, envelopes and canonical JSON, and `@educateos/releases`' pinned key
// entries with retirement. The signing context is OCS's own, so a signature made for a release, an offer or
// any other EducateOS message never verifies as a package publication, and the reverse.
import { EducateOsError, UtcTimestamp } from "@educateos/contracts";
import { canonicalJson, keyIdFor, SignedEnvelope, type SigningIdentity, verifySignature } from "@educateos/fleet";
import { TrustedReleaseKey } from "@educateos/releases";
import { z } from "zod";
import type { PublicationPolicy } from "./durable-object-library.ts";
import type { OcsPackage } from "./package.ts";
import { OcsPackageId, Sha256Digest } from "./schema.ts";
import { SemVer } from "./semver.ts";

const OCS_SIGNING_CONTEXT = "educateos-ocs/v1\0package-publication";
/** SCHO-232: the context of publications signed before the EducateOS rename, which still verify. */
const LEGACY_OCS_SIGNING_CONTEXT = "schoolos-ocs/v1\0package-publication"; // rename-educateos: keep

/** What a publisher signs: one version of one package, by its digest. */
export const PackagePublication = z.strictObject({
  packageId: OcsPackageId,
  version: SemVer,
  digest: Sha256Digest,
  publishedAt: UtcTimestamp,
});
/** A package publication statement. */
export type PackagePublication = z.infer<typeof PackagePublication>;

/** The publisher domain of a package: the part of its ID before the slash. */
export function publisherDomain(packageId: OcsPackageId): string {
  return packageId.slice(0, packageId.indexOf("/"));
}

/**
 * The publisher keys a district approved. Each key list is pinned to one publisher domain, so a key
 * approved for one publisher can never sign another's packages. The district alone changes the
 * list: unlike release trust, no root key set rotates it. `localDomains` are the district's own
 * publishing domains, whose packages it writes itself and does not need signed.
 */
export const PublisherTrust = z.strictObject({
  localDomains: z.array(z.string().min(1).max(200)).max(20),
  publishers: z.array(z.strictObject({ domain: z.string().min(1).max(200), keys: z.array(TrustedReleaseKey).min(1).max(16) })).max(200),
});
/** A district's approved publisher keys. */
export type PublisherTrust = z.infer<typeof PublisherTrust>;

const signedBytes = (publication: unknown, context = OCS_SIGNING_CONTEXT): Uint8Array<ArrayBuffer> => new TextEncoder().encode(`${context}\0${canonicalJson(publication)}`);

/** Signs a package's publication as its publisher. The statement is parsed first, so only a well-formed one is signed. */
export async function signPackagePublication(identity: SigningIdentity, publication: PackagePublication): Promise<SignedEnvelope> {
  const statement = PackagePublication.parse(publication);
  return {
    payload: JSON.parse(canonicalJson(statement)),
    signature: await identity.sign(signedBytes(statement)),
    keyId: identity.keyId,
  };
}

/** Why a publication was not accepted. */
export type PublicationRefusal = "unsigned" | "unknown-publisher" | "bad-signature" | "wrong-package";

/**
 * Checks that `pkg` may enter the district's library: a package from one of the district's own
 * domains needs no signature; any other needs one, by a key the district approved for that
 * package's publisher domain and has not retired by `now`, over exactly this package's ID, version
 * and digest. Nothing carried with the signature, such as a key, is trusted.
 */
export async function checkPublication(
  pkg: Pick<OcsPackage, "manifest" | "digest">,
  signature: unknown,
  trust: PublisherTrust,
  now: Date,
): Promise<{ ok: true; signed: boolean } | { ok: false; reason: PublicationRefusal }> {
  const domain = publisherDomain(pkg.manifest.id);
  if (trust.localDomains.includes(domain)) return { ok: true, signed: false };
  if (signature === undefined) return { ok: false, reason: "unsigned" };
  const envelope = SignedEnvelope.safeParse(signature);
  if (!envelope.success) return { ok: false, reason: "bad-signature" };
  const key = trust.publishers
    .find((publisher) => publisher.domain === domain)
    ?.keys.find((candidate) => candidate.keyId === envelope.data.keyId);
  if (key === undefined || (key.retiresAt !== undefined && now.getTime() >= Date.parse(key.retiresAt))) return { ok: false, reason: "unknown-publisher" };
  if ((await keyIdFor(key.publicKey)) !== key.keyId) return { ok: false, reason: "unknown-publisher" };
  let verified = false;
  for (const context of [OCS_SIGNING_CONTEXT, LEGACY_OCS_SIGNING_CONTEXT]) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = signedBytes(envelope.data.payload, context);
    } catch {
      return { ok: false, reason: "bad-signature" };
    }
    if (await verifySignature(key.publicKey, envelope.data.signature, bytes)) {
      verified = true;
      break;
    }
  }
  if (!verified) return { ok: false, reason: "bad-signature" };
  const statement = PackagePublication.safeParse(envelope.data.payload);
  if (!statement.success) return { ok: false, reason: "bad-signature" };
  const { packageId, version, digest } = statement.data;
  if (packageId !== pkg.manifest.id || version !== pkg.manifest.version || digest !== pkg.digest) return { ok: false, reason: "wrong-package" };
  return { ok: true, signed: true };
}

/**
 * {@link checkPublication}, throwing.
 *
 * @throws EducateOsError `unauthenticated` naming the refusal.
 */
export async function assertPublication(pkg: Pick<OcsPackage, "manifest" | "digest">, signature: unknown, trust: PublisherTrust, now: Date): Promise<boolean> {
  const result = await checkPublication(pkg, signature, trust, now);
  if (!result.ok) throw new EducateOsError("unauthenticated", `the package's publisher signature was not accepted (${result.reason})`);
  return result.signed;
}

/**
 * The library's {@link PublicationPolicy} for a district: {@link assertPublication} against its
 * approved publisher keys, at the time `now` gives.
 */
export function publisherPolicy(trust: PublisherTrust, now: () => Date = () => new Date()): PublicationPolicy {
  return async (pkg, signature) => ({ signed: await assertPublication(pkg, signature, trust, now()) });
}
