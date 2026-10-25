import { EducateOsError, SemVer, UtcTimestamp } from "@educateos/contracts";
import { parseWire, ReleaseChannel, SignedEnvelope } from "@educateos/fleet";
import { z } from "zod";
import { compareSemVer } from "./semver.ts";
import { openReleaseMessage, type ReleaseTrust } from "./trust.ts";

/** A release ID, as the release pipeline names releases (`r123-abc1234`). */
export const ReleaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "expected a release ID");
/** A release ID. */
export type ReleaseId = z.infer<typeof ReleaseId>;

/** A hex-encoded SHA-256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256");

/**
 * A migration note: what a release's migration does, and whether it can be undone. The district
 * must acknowledge every irreversible migration before it approves the release.
 */
export const MigrationNote = z.strictObject({
  /** The migration's ID, e.g. `0002_learning_artifacts` for a D1 migration. */
  migrationId: z.string().regex(/^[0-9]{4}_[a-z0-9_]{1,60}$/, "expected a migration ID"),
  irreversible: z.boolean(),
  /** What it changes, for the district administrator reviewing the release. Root-authored. */
  summary: z.string().min(1).max(500),
});
/** A migration note. */
export type MigrationNote = z.infer<typeof MigrationNote>;

/**
 * What the root asserts about one release on one channel. Signed with a root release key, it is
 * the only thing that makes manifest bytes installable: the district hashes the bytes and compares
 * them with `manifestSha256`.
 */
export const ReleaseManifestStatement = z
  .strictObject({
    releaseId: ReleaseId,
    channel: ReleaseChannel,
    version: SemVer,
    /**
     * The oldest installed version this release can upgrade from, and the floor below which going
     * back to an older release is no longer an ordinary step but needs an explicit rollback.
     */
    minimumCompatibleVersion: SemVer,
    manifestSha256: Sha256Hex,
    migrations: z.array(MigrationNote).max(64),
    issuedAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  })
  .refine((s) => Date.parse(s.issuedAt) < Date.parse(s.expiresAt), { message: "expected issuedAt < expiresAt" })
  .refine((s) => isAtMost(s.minimumCompatibleVersion, s.version), {
    message: "expected minimumCompatibleVersion <= version",
  });
/** A release manifest statement. */
export type ReleaseManifestStatement = z.infer<typeof ReleaseManifestStatement>;

function isAtMost(a: string, b: string): boolean {
  try {
    return compareSemVer(a, b) <= 0;
  } catch {
    return false;
  }
}

/** A signed release manifest: a {@link ReleaseManifestStatement} in a fleet envelope. */
export const SignedReleaseManifest = SignedEnvelope;
/** A signed release manifest. */
export type SignedReleaseManifest = SignedEnvelope;

/**
 * How long after its expiry a release the district already has can still be installed or rolled
 * back to. Offers get no grace: a new release is approved only before its statement expires. This
 * is for the installer, so an approved install or a rollback still runs when the root is
 * unreachable and cannot re-sign (ADR-0001: no root means no new root changes, not an outage).
 */
export const RELEASE_INSTALL_GRACE_MS = 30 * 24 * 60 * 60_000;

/** What {@link verifySignedReleaseManifest} checks the statement against besides its signature. */
export interface ManifestVerificationOptions {
  now: Date;
  /** How long after `expiresAt` the statement is still accepted. Defaults to none. */
  graceMs?: number;
}

/**
 * Verifies a signed release manifest against the district's pinned trust, entirely locally.
 * Fails with `unauthenticated` for an unknown or retired key, a bad signature (including a valid
 * signature over different content) or an expired statement.
 */
export async function verifySignedReleaseManifest(
  input: unknown,
  trust: ReleaseTrust,
  options: ManifestVerificationOptions,
): Promise<ReleaseManifestStatement> {
  const envelope = parseWire(SignedReleaseManifest, input, "signed release manifest");
  const statement = await openReleaseMessage(envelope, "release-manifest", ReleaseManifestStatement, trust, options.now);
  if (statement === undefined) throw new EducateOsError("unauthenticated", "release manifest signature not accepted");
  if (options.now.getTime() >= Date.parse(statement.expiresAt) + (options.graceMs ?? 0)) {
    throw new EducateOsError("unauthenticated", "release manifest statement has expired");
  }
  return statement;
}
