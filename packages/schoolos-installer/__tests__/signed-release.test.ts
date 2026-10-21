import { NORTHFIELD } from "@schoolos/fixtures";
import { InstanceId, SigningIdentity } from "@schoolos/fleet";
import {
  DistrictReleaseManager,
  InMemoryDistrictReleaseStore,
  RELEASE_INSTALL_GRACE_MS,
  ReleaseManifestStatement,
  RootReleaseSigner,
} from "@schoolos/releases";
import { describe, expect, it } from "vitest";
import { dryRunDrift, install, loadPinnedManifest } from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  replaceModule,
  ROOT_SIGNER,
  ROOT_TRUST,
  SECRETS,
  signRelease,
  type TestRelease,
  tokenFor,
} from "./support.ts";

const DAY = 24 * 60 * 60_000;
const HOST = "schoolos.northfield.example";

describe("R03 installer: the signed-manifest path", () => {
  it("rejects a statement signed by a key the district does not pin", async () => {
    const release = await goldenRelease();
    const attacker = new RootReleaseSigner(await SigningIdentity.generate());
    const forged = await attacker.signManifest(ReleaseManifestStatement.parse(release.signedManifest.payload));
    await expect(loadPinnedManifest(release.bytes, configFor(NORTHFIELD, release).release, { signedManifest: forged }))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("rejects a statement for a different release or version than the district pinned", async () => {
    const release = await goldenRelease();
    const pin = configFor(NORTHFIELD, release).release;
    await expect(loadPinnedManifest(release.bytes, { ...pin, version: "0.9.0" }, { signedManifest: release.signedManifest }))
      .rejects.toMatchObject({ code: "validation-failed" });
    await expect(loadPinnedManifest(release.bytes, pin)).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("installs an approved release for a grace period after its statement expires, and not after", async () => {
    const release = await goldenRelease();
    const pin = configFor(NORTHFIELD, release).release;
    const signedAt = new Date("2026-09-01T00:00:00Z");
    const signedManifest = await signRelease(release.manifest.releaseId, "0.1.0", release.sha256, signedAt);
    const expiresAt = signedAt.getTime() + 30 * DAY;

    await expect(loadPinnedManifest(release.bytes, pin, { signedManifest, now: new Date(expiresAt + DAY) })).resolves.toBeDefined();
    await expect(loadPinnedManifest(release.bytes, pin, { signedManifest, now: new Date(expiresAt + RELEASE_INSTALL_GRACE_MS) }))
      .rejects.toMatchObject({ code: "unauthenticated" });
  });
});

async function northfieldOn(r1: TestRelease) {
  const fake = accountFor(NORTHFIELD);
  const api = fake.api(tokenFor(fake, "district-run").tokens);
  const report = await install({ api, config: configFor(NORTHFIELD, r1), manifest: r1.manifest, artifacts: r1.artifacts, secrets: SECRETS });
  expect(report.status).toBe("applied");
  const manager = new DistrictReleaseManager({
    instanceId: InstanceId.parse("ins_northfield"),
    policy: { channel: "stable", autoApply: false },
    store: new InMemoryDistrictReleaseStore(),
    initial: {
      trust: ROOT_TRUST,
      installed: {
        releaseId: r1.manifest.releaseId,
        version: r1.version,
        minimumCompatibleVersion: "0.1.0",
        manifestSha256: r1.sha256,
        installedAt: new Date().toISOString(),
      },
    },
  });
  return { fake, api, manager };
}

async function offerOf(release: TestRelease, offerSequence = 1) {
  const statement = ReleaseManifestStatement.parse(release.signedManifest.payload);
  return await ROOT_SIGNER.signOffer({
    instanceId: InstanceId.parse("ins_northfield"),
    releaseId: statement.releaseId,
    releaseVersion: statement.version,
    channel: statement.channel,
    purpose: "upgrade",
    offerSequence,
    manifestSha256: statement.manifestSha256,
    signedManifest: release.signedManifest,
    offeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
  });
}

describe("R03 installer: offer, dry-run drift, approval and apply", () => {
  it("applies an offered release only after the district approves its drift report", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000002-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r2\n"));
    const { fake, api, manager } = await northfieldOn(r1);
    const record = await manager.receiveOffer(await offerOf(r2));
    const options = { api, config: configFor(NORTHFIELD, r2), manifest: r2.manifest, artifacts: r2.artifacts, secrets: SECRETS };

    const drift = await dryRunDrift(options, r2.sha256);
    expect(drift).toMatchObject({ releaseId: "r000002-fixture", ready: true, pendingMigrations: [] });
    expect(drift.changes).toContainEqual(expect.objectContaining({ resource: expect.stringContaining("router"), action: "update" }));
    // The dry run changed nothing.
    expect(fake.serving(HOST)?.releaseId).toBe(r1.manifest.releaseId);

    await manager.approve(record.offerSequence, { drift });
    const authorized = await manager.authorizeApply(record.offerSequence, await dryRunDrift(options, r2.sha256));
    expect(authorized.statement.manifestSha256).toBe(r2.sha256);
    const manifest = await loadPinnedManifest(r2.bytes, configFor(NORTHFIELD, r2).release, { signedManifest: r2.signedManifest });
    expect((await install({ ...options, manifest })).status).toBe("applied");
    await manager.recordInstalled(record.offerSequence);

    expect(fake.serving(HOST)?.releaseId).toBe("r000002-fixture");
  });

  it("leaves the account untouched when the district declines", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000002-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r2\n"));
    const { fake, manager } = await northfieldOn(r1);
    const record = await manager.receiveOffer(await offerOf(r2));
    const mutationsBefore = fake.calls.filter((c) => c.mutation).length;

    await manager.decline(record.offerSequence, "pilot-term-freeze");

    await expect(manager.authorizeApply(record.offerSequence, {
      releaseId: r2.manifest.releaseId,
      manifestSha256: r2.sha256,
      ready: true,
      changes: [],
      pendingMigrations: [],
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.calls.filter((c) => c.mutation)).toHaveLength(mutationsBefore);
    expect(fake.serving(HOST)?.releaseId).toBe(r1.manifest.releaseId);
  });

  it("finds a D1 migration the root did not declare and holds the release until it is acknowledged", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000002-fixture", async (m, a) => {
      const backend = m.workers["workshop-backend"]!;
      backend.bindings.push({ type: "d1", name: "SCHOOLOS_DB", id: "$D1_SCHOOLOS_DB_ID" });
      const sql = new TextEncoder().encode("CREATE TABLE rosters (id TEXT PRIMARY KEY);");
      const sha256 = await a.addBlob(sql);
      backend.d1Migrations = [{ binding: "SCHOOLOS_DB", id: "0001_rosters", sha256, size: sql.byteLength, r2Key: `blobs/modules/${sha256}` }];
    });
    const { api, manager } = await northfieldOn(r1);
    const record = await manager.receiveOffer(await offerOf(r2));
    const drift = await dryRunDrift({ api, config: configFor(NORTHFIELD, r2), manifest: r2.manifest, artifacts: r2.artifacts, secrets: SECRETS }, r2.sha256);

    expect(drift.pendingMigrations).toEqual(["0001_rosters"]);
    await expect(manager.approve(record.offerSequence, { drift })).rejects.toMatchObject({ code: "policy-violation" });
    await manager.approve(record.offerSequence, { drift, acknowledgedMigrations: ["0001_rosters"] });
    await expect(manager.authorizeApply(record.offerSequence, drift)).resolves.toBeDefined();
  });
});
