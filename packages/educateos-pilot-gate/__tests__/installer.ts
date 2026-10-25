// The installer's side of a revoked grant: the release pipeline's golden release installed into a
// fake district Cloudflare account through the root's OAuth grant, which the district then revokes
// as an upgrade begins. Adapted from @educateos/installer's own revocation scenario.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NORTHFIELD } from "@educateos/fixtures";
import { SigningIdentity } from "@educateos/fleet";
import { pinReleaseKeys, RootReleaseSigner } from "@educateos/releases";
import {
  DistrictInstallConfig,
  FakeCloudflare,
  type FakeCall,
  InMemoryReleaseArtifacts,
  install,
  loadPinnedManifest,
  type ReleaseManifest,
  staticSecretSource,
  staticTokenProvider,
} from "@educateos/installer";

const TESTDATA = fileURLToPath(new URL("../../../scripts/release/testdata/", import.meta.url));
const DOMAIN = "northfield.example";

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

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What happened to the account once the grant was revoked. */
export interface InstallerRevocationOutcome {
  /** The release installed before revocation. */
  firstReleaseId: string;
  /** The error the upgrade stopped with. */
  upgrade: unknown;
  /** Every call the installer made after the grant was revoked. */
  callsAfterRevocation: FakeCall[];
  /** The release the district's hostname serves afterwards. */
  servingAfter: string | undefined;
}

/**
 * Installs release 1 through an OAuth grant, then revokes the grant as the upgrade to release 2
 * makes its first change, and reports what the installer did after that.
 */
export async function installerScenario(): Promise<InstallerRevocationOutcome> {
  const signer = new RootReleaseSigner(await SigningIdentity.generate());
  const offline = await Promise.all([1, 2].map(() => SigningIdentity.generate()));
  const trust = await pinReleaseKeys({ releaseKeys: [signer.identity.publicKey], root: { threshold: 2, publicKeys: offline.map((key) => key.publicKey) } });
  const artifacts = new InMemoryReleaseArtifacts();
  for (const file of filesUnder(join(TESTDATA, "fixture-bundles"))) await artifacts.addBlob(bytesOf(file));
  const goldenBytes = bytesOf(join(TESTDATA, "golden-manifest.json"));
  const golden = JSON.parse(new TextDecoder().decode(goldenBytes)) as ReleaseManifest;
  for (const [path, entry] of Object.entries(golden.workers.router!.assetsConfig!.variants.access!.manifest)) {
    artifacts.addAsset(entry.hash, bytesOf(join(TESTDATA, "fixture-assets", "access", path)));
  }

  const release = async (bytes: Uint8Array<ArrayBuffer>, releaseId: string, version: string) => {
    const now = new Date();
    const signedManifest = await signer.signManifest({
      releaseId,
      channel: "stable",
      version,
      minimumCompatibleVersion: "0.1.0",
      manifestSha256: await sha256Hex(bytes),
      migrations: [],
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    });
    const manifest = await loadPinnedManifest(bytes, { mode: "signed", releaseId, version, trust }, { signedManifest });
    return { manifest, version };
  };
  const r1 = await release(goldenBytes, golden.releaseId, "0.1.0");
  // Release 2 changes the backend's entry module, so applying it would change the account.
  const next = structuredClone(r1.manifest);
  next.releaseId = "r000001-pilot";
  const source = new TextEncoder().encode("export default {}; // r2\n");
  const backend = next.workers["workshop-backend"]!;
  const sha256 = await artifacts.addBlob(source);
  backend.modules = backend.modules.map((m) => (m.name === backend.mainModule ? { ...m, sha256, size: source.byteLength, r2Key: `blobs/modules/${sha256}` } : m));
  const r2 = await release(new TextEncoder().encode(JSON.stringify(next)), next.releaseId, "0.2.0");

  const fake = new FakeCloudflare({ accountId: "a1".repeat(16), accessTeam: "northfield", zones: [{ name: DOMAIN }] });
  const token = fake.issueToken();
  const tokens = staticTokenProvider("oauth", token);
  const run = (target: typeof r1) => install({
    api: fake.api(tokens),
    config: DistrictInstallConfig.parse({
      instanceId: "ins_northfield",
      accountId: "a1".repeat(16),
      baseDomain: DOMAIN,
      access: { teamName: "northfield", allowedEmailDomains: [DOMAIN] },
      admins: [NORTHFIELD.principals.find((p) => p.kind === "staff")!.email],
      release: { mode: "signed", releaseId: target.manifest.releaseId, version: target.version, trust },
      gatekeepers: ["gatekeeper-google"],
      aiGateway: true,
      fleet: {
        districtLabel: NORTHFIELD.district.name,
        commercialAccountId: "acct_northfield",
        contactRole: "district-technology-admin",
        capabilityIds: ["core-learning"],
      },
    }),
    manifest: target.manifest,
    artifacts,
    secrets: staticSecretSource({
      "gatekeeper-google/CLIENT_ID": "synthetic-google-client-id",
      "gatekeeper-google/CLIENT_SECRET": "synthetic-google-client-secret",
    }),
  });
  await run(r1);

  // The district owner revokes the root's grant just as the upgrade starts changing things.
  let revokedAt = -1;
  fake.beforeMutation = () => {
    if (revokedAt < 0) {
      fake.revokeToken(token);
      revokedAt = fake.calls.length;
    }
  };
  const upgrade = await run(r2).then(() => undefined, (error: unknown) => error);
  return {
    firstReleaseId: r1.manifest.releaseId,
    upgrade,
    callsAfterRevocation: revokedAt < 0 ? [] : fake.calls.slice(revokedAt),
    servingAfter: fake.serving(`educateos.${DOMAIN}`)?.releaseId,
  };
}
