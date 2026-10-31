// Adopting a Worker deployed outside the installer (SCHO-243): a ForgeGraph-deployed demo district
// keeps its Worker name, because its Durable Objects hold the district's data. The config names it
// (`services[pkg].scriptName`); planning adopts it only without another instance's marker and with a
// migration tag the release knows, and the managed hostname moves from it to the router.
import { describe, expect, it } from "vitest";
import { compileDesiredState, install, type InstallOptions } from "../src/index.ts";
import { accountFor, configFor, goldenRelease, mutations, NORTHFIELD, SECRETS, type TestRelease, tokenFor } from "./support.ts";

const DISTRICT = "educateos-district-worker";
/** The demo districts' naming, `educateos-<slug>-district`, not the installer's `<prefix>-<pkg>`. */
const DEPLOYED = "educateos-northfield-district";
const HOST = "northfield.educateos.io";
const ROUTER = "educateos-northfield-router";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: true }) };
/** What a ForgeGraph deploy with `syncSecrets` leaves on a demo district (docs/educateos/runbooks/demo-districts.md). */
const DEPLOYED_SECRETS = { DISTRICT_CONFIG: "{}", CF_ACCESS_ISS: "https://gmacko.cloudflareaccess.com", CF_ACCESS_AUD: "aud-demo" };

function adoptConfig(release: TestRelease, service: Record<string, unknown> = {}) {
  return configFor(NORTHFIELD, release, {
    managedHostname: { slug: "northfield" },
    services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS, scriptName: DEPLOYED, ...service } },
  });
}

/** An account holding educateos.io and a demo district deployed by ForgeGraph at its managed hostname. */
function deployedAccount(seed: { vars?: Record<string, string>; migrationTag?: string | null } = {}) {
  const fake = accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
  const migrationTag = seed.migrationTag === null ? {} : { migrationTag: seed.migrationTag ?? "v1" };
  fake.seedDeployedWorker(DEPLOYED, { vars: seed.vars ?? {}, secrets: DEPLOYED_SECRETS, ...migrationTag });
  fake.seedWorkerDomain(HOST, DEPLOYED);
  return { fake, api: fake.api(tokenFor(fake, "district-run").tokens) };
}

function run(api: InstallOptions["api"], release: TestRelease, config = adoptConfig(release), dryRun = false) {
  return install({ api, config, manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS, ...(dryRun ? { dryRun } : {}) });
}

describe("adopting a deployed Worker", () => {
  it("plans the adoption and the move of its managed hostname, and keeps the Worker's name everywhere it is bound", async () => {
    const release = await goldenRelease();
    const { fake, api } = deployedAccount();

    const report = await run(api, release, adoptConfig(release), true);

    expect(report.status).toBe("planned");
    const steps = new Map(report.plan!.steps.map((s) => [s.key, s]));
    expect(steps.get(`worker:${DISTRICT}`)).toMatchObject({
      action: "update",
      reason: `adopts Worker ${DEPLOYED}, deployed outside the installer: keeps its Durable Objects at migration tag v1; ` +
        "deletes secret(s) CF_ACCESS_AUD, CF_ACCESS_ISS, DISTRICT_CONFIG, which the release sets as vars",
      observedMigrationTag: "v1",
      deleteSecrets: ["CF_ACCESS_AUD", "CF_ACCESS_ISS", "DISTRICT_CONFIG"],
    });
    expect(steps.get("domain:managed")).toMatchObject({ action: "update", reason: `moves ${HOST} from Worker ${DEPLOYED} to the router` });
    // Nothing is refused or deleted, and no other existing resource changes: the router, backend,
    // gatekeepers, storage and Access are new. (Settings of the adopted Worker itself, such as its
    // Cron Triggers, may also be brought to the release's.)
    expect(report.plan!.steps.filter((s) => s.action === "refuse" || s.action === "delete" || s.action === "needs-input")).toEqual([]);
    expect(report.plan!.steps.filter((s) => s.action === "update" && !s.key.endsWith(`:${DISTRICT}`)).map((s) => s.key)).toEqual(["domain:managed"]);
    expect(mutations(fake)).toHaveLength(0);

    const desired = compileDesiredState(release.manifest, adoptConfig(release));
    const services = desired.resources.flatMap((r) => (r.kind === "worker_script" ? r.bindings : []))
      .filter((b) => b.type === "service" && String(b.service).includes("district"));
    expect(services.length).toBeGreaterThan(0);
    expect(services.every((b) => b.service === DEPLOYED)).toBe(true);
  });

  it("adopts the Worker without running its migrations again, and moves the hostname to the router", async () => {
    const release = await goldenRelease();
    const { fake, api } = deployedAccount();

    const report = await run(api, release);

    expect(report.status).toBe("applied");
    const district = fake.worker(DEPLOYED)!;
    expect(district.migrationTag).toBe("v1");
    expect(district.bindings.find((b) => b.name === "EDUCATEOS_INSTANCE_ID")?.text).toBe("ins_northfield");
    expect(district.bindings.find((b) => b.name === "CF_ACCESS_AUD")?.text).toBe(fake.accessApplication("educateos-northfield")!.aud);
    expect(district.secretNames).toEqual(["DEVICE_TOKEN_SECRET"]);
    expect(fake.worker("educateos-northfield-educateos-district-worker")).toBeUndefined();
    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
    expect(fake.worker(ROUTER)!.bindings.find((b) => b.name === "DISTRICT")).toMatchObject({ service: DEPLOYED });
    const order = report.applied!.changed;
    expect(order.indexOf("domain:managed")).toBeGreaterThan(order.indexOf("access:application:bypass"));

    const again = await run(api, release);
    expect(again.plan!.steps.filter((s) => s.action !== "noop")).toEqual([]);
  });

  it("finishes an adoption interrupted between deleting the secrets and the upload", async () => {
    const release = await goldenRelease();
    const { fake, api } = deployedAccount();
    let deleted = 0;
    // Before the third delete is counted, the next mutation after it (2 from now) is the upload.
    fake.beforeMutation = (operation) => {
      if (operation === "deleteWorkerSecret" && ++deleted === 3) fake.interruptMutation(2, { effectApplied: false });
    };

    await expect(run(api, release)).rejects.toMatchObject({ operation: "uploadWorkerScript", status: 0 });
    fake.beforeMutation = undefined;
    expect(fake.worker(DEPLOYED)!.secretNames).toEqual([]);

    const resumed = await run(api, release);
    expect(resumed.status).toBe("applied");
    expect(resumed.plan!.steps.find((s) => s.key === `worker:${DISTRICT}`)?.deleteSecrets).toBeUndefined();
    expect(fake.worker(DEPLOYED)!.migrationTag).toBe("v1");
    expect(fake.serving(HOST)?.scriptName).toBe(ROUTER);
  });

  it("refuses a Worker of another instance, one with no or an unknown migration tag, and an unnamed one", async () => {
    const release = await goldenRelease();
    const refusal = async (seed: Parameters<typeof deployedAccount>[0], config = adoptConfig(release)) => {
      const { fake, api } = deployedAccount(seed);
      const report = await run(api, release, config);
      expect(report.status).toBe("plan-blocked");
      expect(mutations(fake)).toHaveLength(0);
      return report.plan!.blocked.find((s) => s.key === `worker:${DISTRICT}`)?.reason;
    };

    expect(await refusal({ vars: { EDUCATEOS_INSTANCE_ID: "ins_riverbend" } })).toBe(`Worker ${DEPLOYED} belongs to instance ins_riverbend`);
    expect(await refusal({ migrationTag: null })).toMatch(/has no Durable Object migration tag, so it holds none of educateos-district-worker's objects: not adopted/);
    expect(await refusal({ migrationTag: "v9" })).toMatch(/is at Durable Object migration tag v9, which this release's educateos-district-worker does not know: not adopted/);
    // Without the config naming it, a Worker of that name is still not the installer's.
    const unnamed = configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } } });
    const { fake, api } = deployedAccount();
    fake.seedDeployedWorker("educateos-northfield-educateos-district-worker", { migrationTag: "v1" });
    const report = await run(api, release, unnamed);
    expect(report.plan!.blocked.find((s) => s.key === `worker:${DISTRICT}`)?.reason)
      .toBe("Worker educateos-northfield-educateos-district-worker exists but was not created by the EducateOS installer");
  });

  it("blocks on an Access application the demo district already has on its hostname", async () => {
    const release = await goldenRelease();
    const { fake, api } = deployedAccount();
    fake.seedAccessApplication("EducateOS demo district: Northfield (northfield.educateos.io)", HOST);

    const report = await run(api, release);
    expect(report.status).toBe("plan-blocked");
    expect(report.plan!.blocked).toEqual([expect.objectContaining({
      key: "access:application",
      reason: `Access application "EducateOS demo district: Northfield (northfield.educateos.io)" already protects ${HOST} and is not this instance's`,
    })]);
  });

  it("refuses a name another Worker of the install has, and retires a disabled service by its configured name", async () => {
    const release = await goldenRelease();
    expect(() => compileDesiredState(release.manifest, adoptConfig(release, { scriptName: ROUTER })))
      .toThrow(`educateos-district-worker and router would both be the Worker ${ROUTER}`);
    const disabled = configFor(NORTHFIELD, release, { services: { [DISTRICT]: { enabled: false, scriptName: DEPLOYED } } });
    expect(compileDesiredState(release.manifest, disabled).resources.find((r) => r.key === `retired:${DISTRICT}`))
      .toMatchObject({ scriptName: DEPLOYED });
  });
});
