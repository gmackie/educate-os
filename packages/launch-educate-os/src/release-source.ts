// Where the release comes from, and why it can be trusted.
//
// Over HTTPS, from educateos.io's read-only mirror (`/releases/`, served by the site Worker from the
// `educateos-releases` bucket), or from a directory laid out as `scripts/release/build-release.ts`
// writes one (an air-gapped install). Either way nothing fetched is trusted until it verifies:
//
// 1. `latest.json` only names a release ID. It is a hint, never trust.
// 2. The release's signed statement must verify against the release keys pinned in this package
//    (or the ones `--trust` names), and must name the requested release.
// 3. The manifest bytes must hash to the statement's SHA-256 (`verifyReleaseManifest`).
// 4. Every module blob must hash to the manifest's SHA-256 and every asset must have its manifest
//    size; the installer checks each one before uploading it (`verifiedBlob`, `verifiedAsset`).
//
// A pointer that names an older release than the one installed is refused unless the operator asked
// to go back (`checkReleaseOrder`), so whoever can edit the bucket can't silently downgrade a district.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EducateOsError } from "@educateos/contracts";
import {
  DirectoryReleaseArtifacts,
} from "@educateos/installer/directory-artifacts";
import {
  type ReleaseArtifacts,
  type ReleaseManifest,
  SIGNED_MANIFEST_FILE,
  type SignedReleasePin,
  verifyReleaseManifest,
} from "@educateos/installer";
import { compareSemVer, type ReleaseManifestStatement, type ReleaseTrust } from "@educateos/releases";
import { z } from "zod";

/** The largest manifest or statement accepted. A manifest is a few hundred kilobytes. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** The largest blob accepted: a Worker module can be at most 10 MiB compressed, 64 MiB raw. */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

const ReleaseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "expected a release ID");
const LatestPointer = z.object({ releaseId: ReleaseId });

/** A release that verified, ready to install. */
export interface VerifiedRelease {
  releaseId: string;
  /** The root's statement about it: version, channel, expiry, migrations. */
  statement: ReleaseManifestStatement;
  manifest: ReleaseManifest;
  /** The pin the install config carries: this release, its version and the trust it verified against. */
  pin: SignedReleasePin;
  artifacts: ReleaseArtifacts;
  /** Where it came from, for the operator. */
  source: string;
}

/** Where releases are read from. */
export type ReleaseLocation = { kind: "url"; base: string } | { kind: "dir"; path: string };

/** What loading a release needs. */
export interface LoadReleaseOptions {
  location: ReleaseLocation;
  /** The release to load. Without it, the newest one the mirror names (a directory holds one release). */
  releaseId?: string;
  trust: ReleaseTrust;
  fetch?: typeof fetch;
  now?: Date;
}

/**
 * The mirror's base URL, normalised to end in `/`. Only https, apart from a loopback http URL for
 * local testing, and never with credentials in it.
 */
export function releaseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EducateOsError("validation-failed", "--release-url must be a URL");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new EducateOsError("validation-failed", "--release-url must be an https URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EducateOsError("validation-failed", "--release-url must not carry credentials, a query or a fragment");
  }
  return url.href.endsWith("/") ? url.href : `${url.href}/`;
}

async function download(fetchImpl: typeof fetch, url: string, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  let lastError = "no response";
  // Transient failures are retried; a 404 or a refusal is not.
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
    } catch {
      lastError = "no response";
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new EducateOsError("not-found", `${url} was not found`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      lastError = `HTTP ${response.status}`;
      if (response.status >= 500 || response.status === 429) continue;
      break;
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > limit) {
      await response.body?.cancel();
      throw new EducateOsError("validation-failed", `${url} is larger than expected`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new EducateOsError("validation-failed", `${url} is larger than expected`);
    return bytes;
  }
  throw new EducateOsError("unavailable", `could not download ${url} (${lastError})`);
}

function json(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EducateOsError("validation-failed", `${what} is not JSON`);
  }
}

/** Release blobs fetched from the mirror. The installer verifies each against the manifest. */
export class HttpReleaseArtifacts implements ReleaseArtifacts {
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(base: string, fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.#base = releaseBaseUrl(base);
    this.#fetch = fetchImpl;
  }

  async blob(sha256: string) {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new EducateOsError("validation-failed", "malformed release blob name");
    return await download(this.#fetch, `${this.#base}blobs/modules/${sha256}`, MAX_BLOB_BYTES);
  }

  async asset(hash: string) {
    if (!/^[0-9a-f]{32}$/.test(hash)) throw new EducateOsError("validation-failed", "malformed release asset name");
    return await download(this.#fetch, `${this.#base}blobs/assets/${hash}`, MAX_BLOB_BYTES);
  }
}

async function readLocal(path: string, what: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const buffer = await readFile(path);
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  } catch {
    throw new EducateOsError("not-found", `${what} is missing (${path})`);
  }
}

/** The ID the mirror's `latest.json` names. Only a hint: the release it names is verified like any other. */
export async function latestReleaseId(base: string, fetchImpl: typeof fetch = fetch.bind(globalThis)): Promise<string> {
  const pointer = LatestPointer.safeParse(json(await download(fetchImpl, `${releaseBaseUrl(base)}latest.json`, 64 * 1024), "latest.json"));
  if (!pointer.success) throw new EducateOsError("validation-failed", "latest.json does not name a release");
  return pointer.data.releaseId;
}

/**
 * Loads one release and verifies it against `trust`: the statement's signature, that it names the
 * requested release, and the manifest's bytes against it. Blobs are verified as they are installed.
 */
export async function loadRelease(options: LoadReleaseOptions): Promise<VerifiedRelease> {
  const fetchImpl = options.fetch ?? fetch.bind(globalThis);
  let releaseId = options.releaseId;
  let manifestBytes: Uint8Array<ArrayBuffer>;
  let signedBytes: Uint8Array<ArrayBuffer>;
  let artifacts: ReleaseArtifacts;
  let source: string;
  if (options.location.kind === "dir") {
    const dir = options.location.path;
    manifestBytes = await readLocal(join(dir, "manifest.json"), "the release manifest");
    signedBytes = await readLocal(join(dir, SIGNED_MANIFEST_FILE), "the release's signed statement");
    artifacts = new DirectoryReleaseArtifacts(dir);
    source = dir;
  } else {
    const base = releaseBaseUrl(options.location.base);
    releaseId ??= await latestReleaseId(base, fetchImpl);
    if (!ReleaseId.safeParse(releaseId).success) throw new EducateOsError("validation-failed", "expected a release ID");
    [signedBytes, manifestBytes] = await Promise.all([
      download(fetchImpl, `${base}${releaseId}/${SIGNED_MANIFEST_FILE}`, MAX_MANIFEST_BYTES),
      download(fetchImpl, `${base}${releaseId}/manifest.json`, MAX_MANIFEST_BYTES),
    ]);
    artifacts = new HttpReleaseArtifacts(base, fetchImpl);
    source = `${base}${releaseId}/`;
  }
  const { manifest, statement } = await verifyReleaseManifest(manifestBytes, json(signedBytes, "the signed statement"), options.trust, options.now);
  if (releaseId !== undefined && statement.releaseId !== releaseId) {
    throw new EducateOsError("validation-failed", `asked for release ${releaseId}, but its statement is for ${statement.releaseId}`);
  }
  return {
    releaseId: statement.releaseId,
    statement,
    manifest,
    pin: { mode: "signed", releaseId: statement.releaseId, version: statement.version, trust: options.trust },
    artifacts,
    source,
  };
}

/** The release an account runs now, as far as the launcher can tell. */
export interface InstalledRelease {
  releaseId: string;
  /** Known when this machine installed it, or its statement could be fetched. */
  version?: string;
}

/** The sequence number of a CI release ID (`r000123-abc1234`), or undefined for any other. */
export function releaseSequence(releaseId: string): number | undefined {
  const match = /^r(\d{6,})-[0-9a-f]{7,40}$/.exec(releaseId);
  return match ? Number(match[1]) : undefined;
}

/**
 * Refuses moving `installed` to `target` when it goes backwards, unless `allowDowngrade`: an older
 * version, or (for the same or an unknown version) a lower release sequence. Also refuses an upgrade the
 * target's statement says it can't make from the installed version. Same release: always fine.
 */
export function checkReleaseOrder(installed: InstalledRelease | undefined, target: ReleaseManifestStatement, allowDowngrade: boolean): void {
  if (installed === undefined || installed.releaseId === target.releaseId) return;
  // By version; between two builds of one version (or with the installed version unknown), by the
  // CI release sequence.
  let older: boolean | undefined;
  const byVersion = installed.version === undefined ? 0 : compareSemVer(target.version, installed.version);
  if (byVersion !== 0) older = byVersion < 0;
  else {
    const [from, to] = [releaseSequence(installed.releaseId), releaseSequence(target.releaseId)];
    if (from !== undefined && to !== undefined) older = to < from;
  }
  if (older === true && !allowDowngrade) {
    throw new EducateOsError(
      "policy-violation",
      `release ${target.releaseId} (${target.version}) is older than the installed ${installed.releaseId}${installed.version ? ` (${installed.version})` : ""}. ` +
        "Going back is a rollback: run `launch-educate-os rollback`, or pass --allow-downgrade if you mean it.",
    );
  }
  if (older === false && installed.version !== undefined && compareSemVer(installed.version, target.minimumCompatibleVersion) < 0) {
    throw new EducateOsError(
      "policy-violation",
      `release ${target.releaseId} (${target.version}) upgrades only from ${target.minimumCompatibleVersion} or later; ` +
        `the installed release is ${installed.version}. Upgrade to an intermediate release first (--release <id>).`,
    );
  }
}
