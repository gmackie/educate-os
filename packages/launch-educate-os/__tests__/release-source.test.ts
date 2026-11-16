// Fetching a release and deciding whether to trust it: the pointer is only a hint, the statement
// must verify against the pinned keys and name the release asked for, the manifest must match the
// statement, every blob must match the manifest, and going back needs asking.
import { readFileSync } from "node:fs";
import { SigningIdentity } from "@educateos/fleet";
import { verifiedAsset, verifiedBlob } from "@educateos/installer";
import { RootReleaseSigner } from "@educateos/releases";
import { afterEach, describe, expect, it } from "vitest";
import { checkReleaseOrder, loadRelease, releaseBaseUrl, releaseSequence } from "../src/release-source.ts";
import { EDUCATEOS_RELEASE_TRUST } from "../src/trust.ts";
import { deriveRelease, goldenRelease, ROOT_TRUST, type ReleaseServer, serveReleases, writeReleaseDir } from "./harness.ts";

const servers: ReleaseServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function world() {
  const golden = await goldenRelease();
  const v1 = await deriveRelease(golden, "r000001-aaaaaaa");
  const v2 = await deriveRelease(golden, "r000002-bbbbbbb");
  const server = await serveReleases(v1, v2);
  servers.push(server);
  return { v1, v2, server };
}

describe("fetching a release", () => {
  it("follows latest.json, then verifies the statement and the manifest against the pinned keys", async () => {
    const { v2, server } = await world();
    const release = await loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST });
    expect(release.releaseId).toBe("r000002-bbbbbbb");
    expect(release.pin).toEqual({ mode: "signed", releaseId: "r000002-bbbbbbb", version: v2.version, trust: ROOT_TRUST });
    expect(server.requests).toEqual(expect.arrayContaining(["latest.json", "r000002-bbbbbbb/manifest.signed.json", "r000002-bbbbbbb/manifest.json"]));
  });

  it("refuses a release signed by any key it doesn't pin", async () => {
    const { server } = await world();
    // The test releases are signed by the synthetic root, which the production pin doesn't trust.
    await expect(loadRelease({ location: { kind: "url", base: server.base }, trust: EDUCATEOS_RELEASE_TRUST }))
      .rejects.toMatchObject({ code: "unauthenticated" });
    const stranger = new RootReleaseSigner(await SigningIdentity.generate());
    const forged = await stranger.signManifest({
      releaseId: "r000002-bbbbbbb", channel: "stable", version: "9.9.9", minimumCompatibleVersion: "0.1.0",
      manifestSha256: "0".repeat(64), migrations: [], issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    server.override("r000002-bbbbbbb/manifest.signed.json", JSON.stringify(forged));
    await expect(loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("refuses a tampered statement, and a manifest that doesn't match it", async () => {
    const { v2, server } = await world();
    const tampered = structuredClone(v2.signedManifest) as unknown as { payload: { version: string } };
    tampered.payload.version = "9.9.9";
    server.override("r000002-bbbbbbb/manifest.signed.json", JSON.stringify(tampered));
    await expect(loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST })).rejects.toMatchObject({ code: "unauthenticated" });

    server.override("r000002-bbbbbbb/manifest.signed.json", JSON.stringify(v2.signedManifest));
    const manifest = JSON.parse(new TextDecoder().decode(v2.bytes)) as { createdAt: string };
    manifest.createdAt = "2020-01-01T00:00:00.000Z";
    server.override("r000002-bbbbbbb/manifest.json", JSON.stringify(manifest));
    await expect(loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST })).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("never trusts the pointer: a statement for another release than the one asked for is refused", async () => {
    const { v1, server } = await world();
    // The mirror serves v1's genuine, signed files under v2's ID.
    server.override("r000002-bbbbbbb/manifest.json", v1.bytes);
    server.override("r000002-bbbbbbb/manifest.signed.json", JSON.stringify(v1.signedManifest));
    await expect(loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST }))
      .rejects.toThrow(/asked for release r000002-bbbbbbb, but its statement is for r000001-aaaaaaa/);
  });

  it("loads a named release, and an offline release directory", async () => {
    const { v1, server } = await world();
    expect((await loadRelease({ location: { kind: "url", base: server.base }, releaseId: "r000001-aaaaaaa", trust: ROOT_TRUST })).releaseId).toBe("r000001-aaaaaaa");
    const dir = await writeReleaseDir(v1);
    const offline = await loadRelease({ location: { kind: "dir", path: dir }, trust: ROOT_TRUST });
    expect(offline.releaseId).toBe("r000001-aaaaaaa");
    await expect(loadRelease({ location: { kind: "dir", path: dir }, releaseId: "r000002-bbbbbbb", trust: ROOT_TRUST })).rejects.toThrow(/asked for release/);
  });

  it("hands the installer blobs it checks against the manifest, so a substituted blob is refused", async () => {
    const { v2, server } = await world();
    const release = await loadRelease({ location: { kind: "url", base: server.base }, trust: ROOT_TRUST });
    const module = v2.manifest.workers.router!.modules[0]!;
    expect((await verifiedBlob(release.artifacts, module.sha256, module.size)).byteLength).toBe(module.size);
    server.override(`blobs/modules/${module.sha256}`, "export default { fetch() { return new Response('pwned') } }");
    await expect(verifiedBlob(release.artifacts, module.sha256, module.size)).rejects.toMatchObject({ code: "validation-failed" });
    const asset = Object.values(v2.manifest.workers.router!.assetsConfig!.variants.access!.manifest)[0]!;
    server.override(`blobs/assets/${asset.hash}`, "x".repeat(asset.size + 1));
    await expect(verifiedAsset(release.artifacts, asset.hash, asset.size)).rejects.toMatchObject({ code: "validation-failed" });
    await expect(release.artifacts.blob("../../etc/passwd")).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("accepts only an https mirror, or http on loopback, with nothing hidden in the URL", () => {
    expect(releaseBaseUrl("https://educateos.io/releases")).toBe("https://educateos.io/releases/");
    expect(releaseBaseUrl("http://127.0.0.1:8080/releases/")).toBe("http://127.0.0.1:8080/releases/");
    for (const bad of ["http://educateos.io/releases/", "https://user:pw@educateos.io/releases/", "https://educateos.io/releases/?x=1", "ftp://x/"]) {
      expect(() => releaseBaseUrl(bad), bad).toThrow();
    }
  });
});

describe("release order", () => {
  const statement = (releaseId: string, version: string, minimumCompatibleVersion = "0.1.0") => ({
    releaseId, version, minimumCompatibleVersion, channel: "stable" as const, manifestSha256: "0".repeat(64), migrations: [],
    issuedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2027-01-01T00:00:00.000Z",
  });

  it("refuses going back to an older release unless asked to", () => {
    const installed = { releaseId: "r000002-bbbbbbb", version: "0.2.0" };
    expect(() => checkReleaseOrder(installed, statement("r000001-aaaaaaa", "0.1.0"), false)).toThrow(/older than the installed/);
    expect(() => checkReleaseOrder(installed, statement("r000001-aaaaaaa", "0.1.0"), true)).not.toThrow();
    expect(() => checkReleaseOrder(installed, statement("r000003-ccccccc", "0.3.0"), false)).not.toThrow();
    expect(() => checkReleaseOrder(installed, statement("r000002-bbbbbbb", "0.2.0"), false)).not.toThrow();
    expect(() => checkReleaseOrder(undefined, statement("r000001-aaaaaaa", "0.1.0"), false)).not.toThrow();
  });

  it("falls back to the release sequence when the installed version is unknown", () => {
    expect(releaseSequence("r000042-0123abc")).toBe(42);
    expect(releaseSequence("dev-20261104")).toBeUndefined();
    expect(() => checkReleaseOrder({ releaseId: "r000009-ccccccc" }, statement("r000008-ddddddd", "1.0.0"), false)).toThrow(/rollback/);
  });

  it("refuses an upgrade the release says it can't make from the installed version", () => {
    expect(() => checkReleaseOrder({ releaseId: "r000001-aaaaaaa", version: "0.1.0" }, statement("r000005-eeeeeee", "2.0.0", "1.0.0"), false))
      .toThrow(/upgrades only from 1.0.0/);
  });
});

describe("the pinned keys", () => {
  it("are educateos.io's RELEASE_TRUST, public halves only", () => {
    const wrangler = readFileSync(new URL("../../../sites/educateos-io/wrangler.jsonc", import.meta.url), "utf8");
    const pinned = /"RELEASE_TRUST":\s*(\{.*\})\s*$/m.exec(wrangler)?.[1];
    expect(JSON.parse(pinned!)).toEqual(EDUCATEOS_RELEASE_TRUST);
    expect(JSON.stringify(EDUCATEOS_RELEASE_TRUST)).not.toContain('"d"');
  });
});
