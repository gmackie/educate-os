import { describe, expect, it } from "vitest";
import { install, rollback } from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  NORTHFIELD,
  replaceModule,
  SECRETS,
  type TestRelease,
  tokenFor,
} from "./support.ts";

async function installed(...releases: TestRelease[]) {
  const fake = accountFor(NORTHFIELD);
  const { tokens } = tokenFor(fake, "district-run");
  const api = fake.api(tokens);
  for (const release of releases) {
    const report = await install({ api, config: configFor(NORTHFIELD, release), manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS });
    expect(report.status).toBe("applied");
  }
  return { fake, api };
}

const HOST = "educateos.northfield.example";

describe("rollback", () => {
  it("redeploys the previous release's Worker versions", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r2\n"));
    const { fake, api } = await installed(r1, r2);
    expect(fake.serving(HOST)?.releaseId).toBe("r000001-fixture");
    const config = configFor(NORTHFIELD, r2);

    const dry = await rollback({ api, config, current: r2.manifest, previous: r1.manifest, dryRun: true });
    expect(dry.deployed).toEqual([]);
    expect(dry.plan.blocked).toEqual([]);
    expect(fake.serving(HOST)?.releaseId).toBe("r000001-fixture");

    const done = await rollback({ api, config, current: r2.manifest, previous: r1.manifest });
    expect(done.deployed).toHaveLength(6);
    expect(fake.serving(HOST)?.releaseId).toBe(r1.manifest.releaseId);
    expect(fake.worker("educateos-northfield-workshop-backend")!.releaseId).toBe(r1.manifest.releaseId);
    // Secrets set on the Worker survive the rollback.
    expect(fake.worker("educateos-northfield-gatekeeper-google")!.secretNames).toEqual(["CLIENT_ID", "CLIENT_SECRET"]);
  });

  it("blocks a rollback across a Durable Object migration and changes nothing", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (m) => {
      m.workers["gatekeeper-scheduler"]!.migrations.push({ tag: "v2", new_sqlite_classes: ["ScheduleAudit"] });
    });
    const { fake, api } = await installed(r1, r2);
    const config = configFor(NORTHFIELD, r2);

    const plan = await rollback({ api, config, current: r2.manifest, previous: r1.manifest, dryRun: true });
    expect(plan.plan.blocked).toEqual([
      expect.objectContaining({ scriptName: "educateos-northfield-gatekeeper-scheduler", reason: expect.stringContaining("not reversible") }),
    ]);
    await expect(rollback({ api, config, current: r2.manifest, previous: r1.manifest })).rejects.toMatchObject({ code: "conflict" });
    expect(fake.serving(HOST)?.releaseId).toBe("r000001-fixture");
  });

  it("flags D1 migrations as not reversible while rolling the code back", async () => {
    const r1 = await goldenRelease();
    const withDb = (id: string, migrations: string[]) => deriveRelease(r1, id, async (m, a) => {
      const backend = m.workers["workshop-backend"]!;
      backend.bindings.push({ type: "d1", name: "EDUCATEOS_DB", id: "$D1_EDUCATEOS_DB_ID" });
      backend.d1Migrations = [];
      for (const migration of migrations) {
        const sql = new TextEncoder().encode(`CREATE TABLE ${migration.slice(5)} (id TEXT PRIMARY KEY);`);
        const sha256 = await a.addBlob(sql);
        backend.d1Migrations.push({ binding: "EDUCATEOS_DB", id: migration, sha256, size: sql.byteLength, r2Key: `blobs/modules/${sha256}` });
      }
    });
    const v1 = await withDb("r000001-fixture", ["0001_principals"]);
    const v2 = await withDb("r000002-fixture", ["0001_principals", "0002_rosters"]);
    const { fake, api } = await installed(v1, v2);
    expect(fake.d1Statements("educateos-northfield-educateos-db")).toEqual([
      "CREATE TABLE principals (id TEXT PRIMARY KEY);",
      "CREATE TABLE rosters (id TEXT PRIMARY KEY);",
    ]);

    const { plan } = await rollback({ api, config: configFor(NORTHFIELD, v2), current: v2.manifest, previous: v1.manifest });

    expect(plan.irreversible).toEqual([expect.stringContaining("D1 migration 0002_rosters")]);
    expect(fake.serving(HOST)?.releaseId).toBe("r000001-fixture");
    // The migration ledger is not rolled back, so reinstalling v2 does not run 0002 twice.
    const { tokens } = tokenFor(fake, "district-run");
    await install({ api: fake.api(tokens), config: configFor(NORTHFIELD, v2), manifest: v2.manifest, artifacts: v2.artifacts, secrets: SECRETS });
    expect(fake.d1Statements("educateos-northfield-educateos-db")).toHaveLength(2);
  });
});
