// Cron Triggers (SCHO-148, SCHO-243): the release's `crons` become the installed Worker's whole
// schedule list, set after the Worker and its secrets exist, and a dashboard edit is drift the next
// apply repairs. The fake keeps schedules across uploads and rollbacks, as Cloudflare is expected to
// (unverified; see docs/educateos/installer-permissions.md).
import { describe, expect, it } from "vitest";
import { compileDesiredState, dryRunDrift, install, type DesiredWorkerSchedules } from "../src/index.ts";
import { accountFor, configFor, deriveRelease, goldenRelease, NORTHFIELD, replaceModule, SECRETS, type TestRelease, tokenFor } from "./support.ts";

const DISTRICT = "educateos-district-worker";
const DISTRICT_SCRIPT = "educateos-northfield-educateos-district-worker";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: true }) };

function setup() {
  const fake = accountFor(NORTHFIELD);
  const { tokens } = tokenFor(fake, "district-run");
  const api = fake.api(tokens);
  const options = (release: TestRelease) => ({
    api,
    config: configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } } }),
    manifest: release.manifest,
    artifacts: release.artifacts,
    secrets: SECRETS,
  });
  return { fake, options, run: (release: TestRelease) => install(options(release)) };
}

describe("Cron Triggers", () => {
  it("compiles one schedules resource per Worker whose release entry declares crons, after the Worker and its secrets", async () => {
    const release = await goldenRelease();
    const config = configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } } });
    const desired = compileDesiredState(release.manifest, config);
    const schedules = desired.resources.filter((r): r is DesiredWorkerSchedules => r.kind === "worker_schedules");

    expect(schedules.map((s) => [s.key, s.scriptName, s.crons])).toEqual([
      [`schedules:${DISTRICT}`, DISTRICT_SCRIPT, release.manifest.workers[DISTRICT]!.crons],
    ]);
    const order = desired.resources.map((r) => r.key);
    for (const dep of schedules[0]!.dependsOn) expect(order.indexOf(dep)).toBeLessThan(order.indexOf(schedules[0]!.key));
    expect(schedules[0]!.dependsOn[0]).toBe(`worker:${DISTRICT}`);
  });

  it("sets the district Worker's crons on install, and a second run finds nothing to do", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    const report = await run(release);

    expect(report.status).toBe("applied");
    expect(fake.worker(DISTRICT_SCRIPT)!.schedules).toEqual(release.manifest.workers[DISTRICT]!.crons);
    const changed = report.applied!.changed;
    expect(changed.indexOf(`schedules:${DISTRICT}`)).toBeGreaterThan(changed.indexOf(`worker:${DISTRICT}`));
    expect(fake.calls.filter((c) => c.operation === "putWorkerSchedules")).toHaveLength(1);

    const again = await run(release);
    expect(again.plan!.steps.find((s) => s.key === `schedules:${DISTRICT}`)).toMatchObject({ action: "noop", reason: "Cron Triggers match" });
    expect(fake.calls.filter((c) => c.operation === "putWorkerSchedules")).toHaveLength(1);
  });

  it("reports a dashboard edit to the schedules as drift, and the next apply restores the release's", async () => {
    const release = await goldenRelease();
    const { fake, options, run } = setup();
    await run(release);
    const crons = release.manifest.workers[DISTRICT]!.crons!;
    fake.editWorkerSchedules(DISTRICT_SCRIPT, [crons[0]!, "*/5 * * * *"]);

    const drift = await dryRunDrift(options(release), release.sha256);
    expect(drift.changes).toEqual([
      { resource: `schedules:${DISTRICT}`, kind: "worker_schedules", action: "update", reason: `Cron Triggers differ: adds ${crons[1]}; removes */5 * * * *` },
    ]);

    expect((await run(release)).status).toBe("applied");
    expect(fake.worker(DISTRICT_SCRIPT)!.schedules).toEqual(crons);
  });

  it("leaves the schedules alone when a release changes only code, and replaces them when the release changes them", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (m, a) => replaceModule(m, a, DISTRICT, "export default {}; // district r2\n"));
    const r3 = await deriveRelease(r1, "r000002-fixture", (m) => {
      m.workers[DISTRICT]!.crons = ["0 6 * * MON-FRI"];
    });
    const { fake, run } = setup();
    await run(r1);

    const upgrade = await run(r2);
    expect(upgrade.plan!.steps.find((s) => s.key === `schedules:${DISTRICT}`)?.action).toBe("noop");
    expect(fake.worker(DISTRICT_SCRIPT)!.schedules).toEqual(r1.manifest.workers[DISTRICT]!.crons);

    const changed = await run(r3);
    expect(changed.plan!.steps.find((s) => s.key === `schedules:${DISTRICT}`)?.action).toBe("update");
    expect(fake.worker(DISTRICT_SCRIPT)!.schedules).toEqual(["0 6 * * MON-FRI"]);
  });

  it("refuses an expression Cloudflare can't parse at apply, after the Worker is up", async () => {
    const r1 = await goldenRelease();
    const bad = await deriveRelease(r1, "r000003-fixture", (m) => {
      m.workers[DISTRICT]!.crons = ["every day"];
    });
    const { fake, run } = setup();

    await expect(run(bad)).rejects.toMatchObject({ operation: "putWorkerSchedules", status: 400 });
    expect(fake.worker(DISTRICT_SCRIPT)!.schedules).toEqual([]);
  });
});
