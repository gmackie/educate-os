import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NORTHFIELD, RIVERBEND } from "@schoolos/fixtures";
import {
  InMemoryInstanceRegistryStorage,
  InstanceRegistry,
  type SignedEnvelope,
  SigningIdentity,
} from "@schoolos/fleet";
import { pinReleaseKeys, RootReleaseSigner } from "@schoolos/releases";
import type { DistrictDirectorySnapshot } from "@schoolos/contracts";
import {
  DistrictInstallConfig,
  FakeCloudflare,
  type FakeAccountOptions,
  InMemoryReleaseArtifacts,
  loadPinnedManifest,
  type ReleaseManifest,
  type RegistryEndpoint,
  staticSecretSource,
  staticTokenProvider,
  type TokenProvider,
} from "../src/index.ts";
import { sha256Hex } from "../src/digest.ts";

// The release pipeline's own golden manifest and fixture bundles: the installer consumes exactly
// what manifest-lib produces.
const TESTDATA = fileURLToPath(new URL("../../../scripts/release/testdata/", import.meta.url));

function bytesOf(path: string): Uint8Array<ArrayBuffer> {
  const buffer = readFileSync(path);
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The synthetic root's release-signing key, and the trust every test district pins for it. */
export const ROOT_SIGNER = new RootReleaseSigner(await SigningIdentity.generate());
/** The release keys a test district pins. */
export const ROOT_TRUST = await pinReleaseKeys([ROOT_SIGNER.identity.publicKey]);

/** A release as the installer receives it: manifest bytes, the root's signed statement and the blobs. */
export interface TestRelease {
  manifest: ReleaseManifest;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  version: string;
  signedManifest: SignedEnvelope;
  artifacts: InMemoryReleaseArtifacts;
}

/** The root's signed statement for manifest bytes, valid for 30 days from `now`. */
export async function signRelease(releaseId: string, version: string, sha256: string, now = new Date()): Promise<SignedEnvelope> {
  return await ROOT_SIGNER.signManifest({
    releaseId,
    channel: "stable",
    version,
    minimumCompatibleVersion: "0.1.0",
    manifestSha256: sha256,
    migrations: [],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
  });
}

async function signedRelease(bytes: Uint8Array<ArrayBuffer>, releaseId: string, version: string, artifacts: InMemoryReleaseArtifacts): Promise<TestRelease> {
  const sha256 = await sha256Hex(bytes);
  const signedManifest = await signRelease(releaseId, version, sha256);
  const manifest = await loadPinnedManifest(bytes, { mode: "signed", releaseId, version, trust: ROOT_TRUST }, { signedManifest });
  return { manifest, bytes, sha256, version, signedManifest, artifacts };
}

/** The golden manifest from scripts/release, with its fixture bundles and assets as blobs. */
export async function goldenRelease(): Promise<TestRelease> {
  const bytes = bytesOf(join(TESTDATA, "golden-manifest.json"));
  const artifacts = new InMemoryReleaseArtifacts();
  for (const file of filesUnder(join(TESTDATA, "fixture-bundles"))) await artifacts.addBlob(bytesOf(file));
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
  const variant = parsed.workers.router!.assetsConfig!.variants.access!.manifest;
  for (const [path, entry] of Object.entries(variant)) {
    artifacts.addAsset(entry.hash, bytesOf(join(TESTDATA, "fixture-assets", "access", path)));
  }
  return await signedRelease(bytes, parsed.releaseId, "0.1.0", artifacts);
}

/** A new release derived from another: a new ID, edited by `edit`, sharing the same blob store. */
export async function deriveRelease(
  base: TestRelease,
  releaseId: string,
  edit: (manifest: ReleaseManifest, artifacts: InMemoryReleaseArtifacts) => Promise<void> | void = () => {},
): Promise<TestRelease> {
  const manifest = structuredClone(base.manifest);
  manifest.releaseId = releaseId;
  await edit(manifest, base.artifacts);
  return await signedRelease(new TextEncoder().encode(JSON.stringify(manifest)), releaseId, "0.2.0", base.artifacts);
}

/** Replaces a worker's entry module with new bytes, as a code-only release would. */
export async function replaceModule(manifest: ReleaseManifest, artifacts: InMemoryReleaseArtifacts, pkg: string, source: string) {
  const bytes = new TextEncoder().encode(source);
  const sha256 = await artifacts.addBlob(bytes);
  const worker = manifest.workers[pkg]!;
  worker.modules = worker.modules.map((m) =>
    m.name === worker.mainModule ? { ...m, sha256, size: bytes.byteLength, r2Key: `blobs/modules/${sha256}` } : m);
}

const ACCOUNTS: Record<string, string> = {
  dst_northfield: "a1".repeat(16),
  dst_riverbend: "b2".repeat(16),
};

/** The district's domain, from its fixture. */
export function domainOf(snapshot: DistrictDirectorySnapshot): string {
  return snapshot.district.id === NORTHFIELD.district.id ? "northfield.example" : "riverbend.example";
}

/** An install config for a synthetic district at a release. */
export function configFor(snapshot: DistrictDirectorySnapshot, release: TestRelease, overrides: Record<string, unknown> = {}) {
  const slug = snapshot.district.id.slice("dst_".length);
  const domain = domainOf(snapshot);
  return DistrictInstallConfig.parse({
    instanceId: `ins_${slug}`,
    accountId: ACCOUNTS[snapshot.district.id],
    baseDomain: domain,
    access: { teamName: slug, allowedEmailDomains: [domain] },
    admins: [snapshot.principals.find((p) => p.kind === "staff")!.email],
    release: { mode: "signed", releaseId: release.manifest.releaseId, version: release.version, trust: ROOT_TRUST },
    gatekeepers: ["gatekeeper-google"],
    aiGateway: true,
    fleet: {
      districtLabel: snapshot.district.name,
      commercialAccountId: `acct_${slug}`,
      contactRole: "district-technology-admin",
      capabilityIds: ["core-learning"],
    },
    ...overrides,
  });
}

/** A Cloudflare account ready for a district install. */
export function accountFor(snapshot: DistrictDirectorySnapshot, options: Partial<FakeAccountOptions> = {}) {
  return new FakeCloudflare({
    accountId: ACCOUNTS[snapshot.district.id]!,
    accessTeam: snapshot.district.id.slice("dst_".length),
    zones: [{ name: domainOf(snapshot) }],
    ...options,
  });
}

/** Synthetic gatekeeper OAuth app credentials. */
export const SECRETS = staticSecretSource({
  "gatekeeper-google/CLIENT_ID": "synthetic-google-client-id",
  "gatekeeper-google/CLIENT_SECRET": "synthetic-google-client-secret",
});

/** A token provider for a fresh token of the given mode. */
export function tokenFor(fake: FakeCloudflare, mode: TokenProvider["mode"]) {
  const token = fake.issueToken();
  return { token, tokens: staticTokenProvider(mode, token) };
}

/** The root's registry, reachable in process until `shutDown`. */
export function makeRoot() {
  const storage = new InMemoryInstanceRegistryStorage();
  const registry = new InstanceRegistry({ storage });
  let up = true;
  const endpoint: RegistryEndpoint = {
    async register(envelope: SignedEnvelope) {
      if (!up) throw new TypeError("fetch failed");
      return await registry.register(structuredClone(envelope));
    },
  };
  return {
    storage,
    endpoint,
    shutDown() {
      up = false;
    },
  };
}

/** Mutating calls recorded by a fake, by outcome. */
export function mutations(fake: FakeCloudflare) {
  return fake.calls.filter((c) => c.mutation);
}

export { NORTHFIELD, RIVERBEND };
