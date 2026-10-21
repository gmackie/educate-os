// Signs a release manifest with the SchoolOS root release key, producing the
// `SignedReleaseManifest` (`@schoolos/releases`) that `@schoolos/installer` verifies against the
// keys a district pins. build-release.ts and promote-release.ts write it next to manifest.json as
// `manifest.signed.json`.
//
// The key is an Ed25519 private JWK (`SigningIdentity.exportJwk()`), held as a CI secret in
// RELEASE_SIGNING_KEY_ENV. Signing is optional: with the variable unset the scripts build an
// unsigned development release, which the installer accepts only through its `insecure-pin` mode.
// The key is never written to disk or printed, and errors about it never quote it.
//
// Imported by relative path, like scripts/evals does with its packages: a workspace dependency on
// @schoolos/releases would be a cycle, since every SchoolOS package dev-depends on @gadgets/scripts.

import { createHash } from "node:crypto";
import { Ed25519PrivateJwk, SigningIdentity } from "../../packages/schoolos-fleet/src/index.ts";
import {
  type MigrationNote,
  pinReleaseKeys,
  type ReleaseManifestStatement,
  RootReleaseSigner,
  type SignedReleaseManifest,
  verifySignedReleaseManifest,
} from "../../packages/schoolos-releases/src/index.ts";
import type { ReleaseManifest } from "./manifest-lib.ts";

/** The environment variable holding the root release signing key, an Ed25519 private JWK as JSON. */
export const RELEASE_SIGNING_KEY_ENV = "SCHOOLOS_RELEASE_SIGNING_KEY";

/** The signed statement's file name, next to `manifest.json` locally and in R2. */
export const SIGNED_MANIFEST_FILE = "manifest.signed.json";

/**
 * How long a statement is valid by default. The installer accepts it for 30 days past expiry
 * (`RELEASE_INSTALL_GRACE_MS`), so an approved release can still be installed or rolled back to
 * when the root cannot re-sign.
 */
export const DEFAULT_STATEMENT_DAYS = 90;

const DAY_MS = 24 * 60 * 60_000;

/** What the root asserts about a release besides its bytes. */
export interface ReleaseSigningOptions {
  /** The release's semantic version. */
  version: string;
  /** The channel it is offered on. */
  channel: ReleaseManifestStatement["channel"];
  /** The oldest version it upgrades from. Defaults to `version`. */
  minimumCompatibleVersion?: string;
  /** Days until the statement expires. Defaults to {@link DEFAULT_STATEMENT_DAYS}. */
  validDays?: number;
  /** The signing time. Defaults to now. */
  now?: Date;
}

/**
 * The root release key from the environment, or undefined when it is unset or empty (an unsigned
 * development build). A value that is not an Ed25519 private JWK fails without quoting it.
 */
export async function releaseSigningKey(
  env: Record<string, string | undefined>,
): Promise<SigningIdentity | undefined> {
  const value = env[RELEASE_SIGNING_KEY_ENV]?.trim();
  if (!value) return undefined;
  try {
    return await SigningIdentity.fromJwk(Ed25519PrivateJwk.parse(JSON.parse(value)));
  } catch {
    // JSON.parse and Zod errors can quote the input; this one must not. Web Crypto also lands
    // here when the public half `x` does not belong to `d`.
    throw new Error(`${RELEASE_SIGNING_KEY_ENV} is not an Ed25519 private JWK ` +
        `({ kty: "OKP", crv: "Ed25519", x, d })`);
  }
}

/**
 * The migration notes a release's statement carries: one per D1 migration ID, all irreversible,
 * since the installer never reverses one. The district acknowledges each before approving.
 */
export function migrationNotes(manifest: Pick<ReleaseManifest, "workers">): MigrationNote[] {
  const targets = new Map<string, string[]>();
  for (const [pkgName, entry] of Object.entries(manifest.workers)) {
    for (const { id, binding } of entry.d1Migrations ?? []) {
      targets.set(id, [...(targets.get(id) ?? []), `${pkgName} ${binding}`]);
    }
  }
  return [...targets].toSorted(([a], [b]) => a.localeCompare(b)).map(([migrationId, on]) => ({
    migrationId,
    irreversible: true,
    summary: `D1 migration on ${on.join(", ")}`.slice(0, 500),
  }));
}

/**
 * Signs manifest bytes: a statement naming their SHA-256 and the release they describe. The
 * envelope is verified against the signing key's own public key before it is returned, so a
 * statement no district pinning that key could accept is never published.
 */
export async function signReleaseManifest(
  manifestBytes: Uint8Array,
  identity: SigningIdentity,
  options: ReleaseSigningOptions,
): Promise<SignedReleaseManifest> {
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ReleaseManifest;
  const now = options.now ?? new Date();
  const signed = await new RootReleaseSigner(identity).signManifest({
    releaseId: manifest.releaseId,
    channel: options.channel,
    version: options.version,
    minimumCompatibleVersion: options.minimumCompatibleVersion ?? options.version,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    migrations: migrationNotes(manifest),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (options.validDays ?? DEFAULT_STATEMENT_DAYS) * DAY_MS).toISOString(),
  });
  await verifySignedReleaseManifest(signed, await pinReleaseKeys([identity.publicKey]), { now });
  return signed;
}

/**
 * Parses the signing flags build-release.ts and promote-release.ts share, consuming them from
 * `argv` at `i`. Returns the index of the last argument consumed, or undefined if `argv[i]` is not
 * a signing flag.
 */
export function parseSigningArg(
  argv: string[], i: number, into: Partial<ReleaseSigningOptions>,
): number | undefined {
  const value = argv[i + 1];
  switch (argv[i]) {
    case "--version": into.version = value; return i + 1;
    case "--channel": into.channel = value as ReleaseSigningOptions["channel"]; return i + 1;
    case "--minimum-compatible-version": into.minimumCompatibleVersion = value; return i + 1;
    case "--valid-days": into.validDays = Number(value); return i + 1;
    default: return undefined;
  }
}

/**
 * The signing options, once a key is present: `--version` and `--channel` are then required, so a
 * CI misconfiguration fails the release rather than quietly producing an unsigned one.
 */
export function requireSigningOptions(options: Partial<ReleaseSigningOptions>): ReleaseSigningOptions {
  if (!options.version || !options.channel) {
    throw new Error(`${RELEASE_SIGNING_KEY_ENV} is set, so --version <semver> and ` +
        `--channel <canary|stable|lts> are required to sign the release`);
  }
  if (options.validDays !== undefined && !(Number.isInteger(options.validDays) && options.validDays > 0)) {
    throw new Error("--valid-days must be a positive integer");
  }
  return { ...options, version: options.version, channel: options.channel };
}
