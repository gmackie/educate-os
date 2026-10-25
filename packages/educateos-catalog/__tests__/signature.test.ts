// Catalog release signatures against `@educateos/releases` trust (SCHO-64): the mirror installs a
// release only if a release key the district pins signed exactly that release.
import { PrincipalId } from "@educateos/contracts";
import { type Ed25519PublicKey, SigningIdentity } from "@educateos/fleet";
import { pinReleaseKeys, type ReleaseTrust, signReleaseMessage } from "@educateos/releases";
import { describe, expect, it } from "vitest";
import {
  CatalogMirror,
  type CatalogRelease,
  catalogReleaseVerifier,
  catalogSeedRelease,
  InMemoryCatalogMirrorStorage,
  signCatalogRelease,
} from "../src/index.ts";

const ADMIN = { by: PrincipalId.parse("prn_nf-district-admin"), at: "2026-10-20T09:00:00Z" };
const NOW = new Date("2026-10-21T00:00:00Z");

// Catalog releases verify against the release keys alone; the offline root quorum only governs
// release key sets, so a throwaway root fills that slot.
async function pin(releaseKey: Ed25519PublicKey): Promise<ReleaseTrust> {
  const offlineRoot = await SigningIdentity.generate();
  return pinReleaseKeys({ releaseKeys: [releaseKey], root: { threshold: 1, publicKeys: [offlineRoot.publicKey] } });
}

async function setup(trustOf: (releaseKey: SigningIdentity) => Promise<ReleaseTrust> = async (releaseKey) => pin(releaseKey.publicKey)) {
  const root = await SigningIdentity.generate();
  const trust = await trustOf(root);
  const verify = catalogReleaseVerifier({ trust: async () => trust, now: () => NOW });
  return { root, verify, release: await catalogSeedRelease("ccss-math") };
}

describe("catalog release signatures", () => {
  it("accepts a release a pinned release key signed", async () => {
    const { root, verify, release } = await setup();
    expect(await verify(await signCatalogRelease(root, release))).toBe(true);
  });

  it("refuses an unsigned release, and one signed by a key the district does not pin", async () => {
    const { verify, release } = await setup();
    expect(await verify(release)).toBe(false);
    expect(await verify(await signCatalogRelease(await SigningIdentity.generate(), release))).toBe(false);
    expect(await verify({ ...release, signature: { keyId: "not-a-key", signature: "not-a-signature" } })).toBe(false);
  });

  it("refuses a signature carried over to another version or another digest", async () => {
    const { root, verify, release } = await setup();
    const signed = await signCatalogRelease(root, release);
    expect(await verify({ ...signed, version: "1.0.1" })).toBe(false);
    expect(await verify({ ...signed, contentDigest: `sha256:${"0".repeat(64)}` })).toBe(false);
    expect(await verify({ ...signed, frameworkKey: "ccss-ela" as CatalogRelease["frameworkKey"] })).toBe(false);
  });

  it("refuses a signature the same key made over the same statement as another message kind", async () => {
    const { root, verify, release } = await setup();
    const statement = { frameworkKey: release.frameworkKey, version: release.version, releasedAt: release.releasedAt, contentDigest: release.contentDigest };
    const asManifest = await signReleaseMessage(root, "release-manifest", statement);
    expect(await verify({ ...release, signature: { keyId: asManifest.keyId, signature: asManifest.signature } })).toBe(false);
  });

  it("refuses a key once its pinned trust has retired it", async () => {
    const { root, verify, release } = await setup(async (key) => {
      const trust = await pin(key.publicKey);
      return { ...trust, keys: trust.keys.map((k) => ({ ...k, retiresAt: "2026-10-20T00:00:00.000Z" })) };
    });
    expect(await verify(await signCatalogRelease(root, release))).toBe(false);
  });

  it("is what the mirror installs through, refusing an unsigned release", async () => {
    const { root, verify, release } = await setup();
    const mirror = new CatalogMirror({ storage: new InMemoryCatalogMirrorStorage(), verifyRelease: verify });
    await mirror.select("ccss-math", ADMIN);
    await expect(mirror.install(release, ADMIN)).rejects.toMatchObject({ code: "policy-violation" });
    const { release: installed } = await mirror.install(await signCatalogRelease(root, release), ADMIN);
    expect(installed.status).toBe("proposed");
  });
});
