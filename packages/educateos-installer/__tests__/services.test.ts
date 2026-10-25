// Optional backend services (release worker kind `service`, SCHO-131): the AI call guard is
// installed from the release, bound to the backend as AI_CALL_GUARD after it and its secret
// exist, unbound before it is deleted, and covered by drift detection and rollback.
import { describe, expect, it } from "vitest";
import { compileDesiredState, dryRunDrift, install, rollback, staticSecretSource } from "../src/index.ts";
import {
  accountFor,
  configFor,
  deriveRelease,
  goldenRelease,
  mutations,
  NORTHFIELD,
  replaceModule,
  type TestRelease,
  tokenFor,
} from "./support.ts";

const GUARD = "educateos-ai-guard";
const GUARD_SCRIPT = "educateos-northfield-educateos-ai-guard";
const BACKEND_SCRIPT = "educateos-northfield-workshop-backend";

const GUARD_VARS = {
  AI_GUARD_CONFIG: JSON.stringify({ districtId: "dst_northfield", note: "a literal $USD is not a placeholder" }),
  HALL_MONITOR_URL: "https://hall-monitor.example",
  HALL_MONITOR_ISSUER: "educateos-northfield",
};

const SECRETS_WITH_GUARD = staticSecretSource({
  "gatekeeper-google/CLIENT_ID": "synthetic-google-client-id",
  "gatekeeper-google/CLIENT_SECRET": "synthetic-google-client-secret",
  [`${GUARD}/HALL_MONITOR_SIGNING_KEY`]: '{"kty":"OKP","crv":"Ed25519","d":"synthetic","x":"synthetic","kid":"k1"}',
});

const SECRETS_WITHOUT_GUARD = staticSecretSource({
  "gatekeeper-google/CLIENT_ID": "synthetic-google-client-id",
  "gatekeeper-google/CLIENT_SECRET": "synthetic-google-client-secret",
});

function guardConfig(release: TestRelease, guard: { enabled: boolean; vars?: Record<string, string> } | undefined) {
  return configFor(NORTHFIELD, release, guard ? { services: { [GUARD]: guard } } : {});
}

function setup() {
  const fake = accountFor(NORTHFIELD);
  const { tokens } = tokenFor(fake, "district-run");
  const api = fake.api(tokens);
  const run = (release: TestRelease, guard: Parameters<typeof guardConfig>[1], extra: { secrets?: typeof SECRETS_WITH_GUARD; dryRun?: boolean } = {}) =>
    install({
      api,
      config: guardConfig(release, guard),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: extra.secrets ?? SECRETS_WITH_GUARD,
      ...(extra.dryRun ? { dryRun: true } : {}),
    });
  return { fake, api, run };
}

const guardBinding = (fake: ReturnType<typeof accountFor>) =>
  fake.worker(BACKEND_SCRIPT)!.bindings.find((b) => b.name === "AI_CALL_GUARD");

describe("optional backend services", () => {
  it("installs the guard with its inputs and binds it to the backend only after it and its secret exist", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    const report = await run(release, { enabled: true, vars: GUARD_VARS });

    expect(report.status).toBe("applied");
    const guard = fake.worker(GUARD_SCRIPT)!;
    expect(guard.secretNames).toEqual(["HALL_MONITOR_SIGNING_KEY"]);
    expect(guard.migrationTag).toBe("v1");
    const byName = new Map(guard.bindings.map((b) => [b.name, b]));
    expect(byName.get("AI_GUARD_CONFIG")).toEqual({ type: "plain_text", name: "AI_GUARD_CONFIG", text: GUARD_VARS.AI_GUARD_CONFIG });
    expect(byName.get("HALL_MONITOR_URL")?.text).toBe(GUARD_VARS.HALL_MONITOR_URL);
    expect(byName.get("EDUCATEOS_INSTANCE_ID")?.text).toBe("ins_northfield");
    expect(guardBinding(fake)).toEqual({ type: "service", name: "AI_CALL_GUARD", service: GUARD_SCRIPT, entrypoint: "EducateOsAiCallGuard" });

    const order = report.applied!.changed;
    const backendAt = order.indexOf("worker:workshop-backend");
    expect(order.indexOf(`worker:${GUARD}`)).toBeLessThan(backendAt);
    expect(order.indexOf(`secret:${GUARD}:HALL_MONITOR_SIGNING_KEY`)).toBeLessThan(backendAt);

    const again = await run(release, { enabled: true, vars: GUARD_VARS }, { secrets: SECRETS_WITHOUT_GUARD });
    expect(again.status).toBe("applied");
    expect(again.plan!.steps.every((s) => s.action === "noop")).toBe(true);
  });

  it("leaves a service the config does not name alone, and the backend unbound", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();
    await run(release, undefined);
    expect(fake.worker(GUARD_SCRIPT)).toBeUndefined();
    expect(guardBinding(fake)).toBeUndefined();
  });

  it("adds the guard to an existing install, and the dry run shows the service and the binding", async () => {
    const release = await goldenRelease();
    const { fake, api, run } = setup();
    await run(release, undefined);
    const before = mutations(fake).length;

    const drift = await dryRunDrift({
      api,
      config: guardConfig(release, { enabled: true, vars: GUARD_VARS }),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS_WITH_GUARD,
    }, release.sha256);

    expect(drift.ready).toBe(true);
    expect(drift.changes).toEqual([
      expect.objectContaining({ resource: `worker:${GUARD}`, action: "create" }),
      expect.objectContaining({ resource: `secret:${GUARD}:HALL_MONITOR_SIGNING_KEY`, action: "create" }),
      expect.objectContaining({
        resource: "worker:workshop-backend",
        action: "update",
        reason: expect.stringContaining(`binds AI_CALL_GUARD to ${GUARD_SCRIPT} (EducateOsAiCallGuard)`),
      }),
    ]);
    expect(mutations(fake)).toHaveLength(before);

    expect((await run(release, { enabled: true, vars: GUARD_VARS })).status).toBe("applied");
    expect(guardBinding(fake)?.service).toBe(GUARD_SCRIPT);
  });

  it("upgrades the guard with a release, leaving the backend's binding in place", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (m, a) => replaceModule(m, a, GUARD, "export default {}; // guard r2\n"));
    const { fake, run } = setup();
    await run(r1, { enabled: true, vars: GUARD_VARS });

    const report = await run(r2, { enabled: true, vars: GUARD_VARS }, { secrets: SECRETS_WITHOUT_GUARD });

    expect(report.status).toBe("applied");
    expect(fake.worker(GUARD_SCRIPT)).toMatchObject({ releaseId: "r000001-fixture", secretNames: ["HALL_MONITOR_SIGNING_KEY"] });
    expect(guardBinding(fake)?.service).toBe(GUARD_SCRIPT);
  });

  it("disables the guard: removes the backend binding, then deletes the Worker", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();
    await run(release, { enabled: true, vars: GUARD_VARS });

    const plan = await run(release, { enabled: false }, { dryRun: true });
    const changes = plan.plan!.steps.filter((s) => s.action !== "noop");
    expect(changes.map((s) => [s.key, s.action])).toEqual([
      ["worker:workshop-backend", "update"],
      [`retired:${GUARD}`, "delete"],
    ]);
    expect(changes[0]!.reason).toContain("removes binding AI_CALL_GUARD");
    expect(fake.worker(GUARD_SCRIPT)).toBeDefined();

    const report = await run(release, { enabled: false });
    expect(report.applied!.changed).toEqual(["worker:workshop-backend", `retired:${GUARD}`]);
    expect(fake.worker(GUARD_SCRIPT)).toBeUndefined();
    expect(guardBinding(fake)).toBeUndefined();

    const again = await run(release, { enabled: false });
    expect(again.plan!.steps.every((s) => s.action === "noop")).toBe(true);
  });

  it("never deletes a Worker of the service's name that this instance does not own", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();
    await run(release, undefined);
    fake.seedWorker(GUARD_SCRIPT, { EDUCATEOS_INSTANCE_ID: "ins_someone_else" });

    const report = await run(release, { enabled: false });

    expect(report.status).toBe("applied");
    expect(report.plan!.steps.find((s) => s.key === `retired:${GUARD}`)).toMatchObject({ action: "noop" });
    expect(fake.worker(GUARD_SCRIPT)).toBeDefined();
  });

  it("detects a removed or retargeted AI_CALL_GUARD binding as drift and repairs it", async () => {
    const release = await goldenRelease();
    const { fake, api, run } = setup();
    await run(release, { enabled: true, vars: GUARD_VARS });
    const options = {
      api,
      config: guardConfig(release, { enabled: true, vars: GUARD_VARS }),
      manifest: release.manifest,
      artifacts: release.artifacts,
      secrets: SECRETS_WITH_GUARD,
    };

    fake.editWorkerBindings(BACKEND_SCRIPT, (bindings) => bindings.filter((b) => b.name !== "AI_CALL_GUARD"));
    const removed = await dryRunDrift(options, release.sha256);
    expect(removed.changes).toEqual([
      expect.objectContaining({ resource: "worker:workshop-backend", action: "update", reason: `drift: binds AI_CALL_GUARD to ${GUARD_SCRIPT} (EducateOsAiCallGuard)` }),
    ]);

    fake.editWorkerBindings(BACKEND_SCRIPT, (bindings) => [...bindings, { type: "service", name: "AI_CALL_GUARD", service: "attacker-guard" }]);
    const retargeted = await dryRunDrift(options, release.sha256);
    expect(retargeted.changes[0]?.reason).toBe(`drift: rebinds AI_CALL_GUARD from attacker-guard to ${GUARD_SCRIPT} (EducateOsAiCallGuard)`);

    expect((await run(release, { enabled: true, vars: GUARD_VARS })).status).toBe("applied");
    expect(guardBinding(fake)).toMatchObject({ service: GUARD_SCRIPT, entrypoint: "EducateOsAiCallGuard" });
    expect((await dryRunDrift(options, release.sha256)).changes).toEqual([]);
  });

  it("blocks in preflight, before any change, when the guard's secret or a var is missing", async () => {
    const release = await goldenRelease();
    const { fake, run } = setup();

    const noSecret = await run(release, { enabled: true, vars: GUARD_VARS }, { secrets: SECRETS_WITHOUT_GUARD });
    expect(noSecret.status).toBe("preflight-blocked");
    expect(noSecret.preflight.blocking).toEqual([
      expect.objectContaining({ code: "service.secret-missing", operatorAction: expect.stringContaining("EDUCATEOS_SECRET_EDUCATEOS_AI_GUARD__HALL_MONITOR_SIGNING_KEY") }),
    ]);

    const { HALL_MONITOR_URL: _omitted, ...partial } = GUARD_VARS;
    const noVar = await run(release, { enabled: true, vars: partial });
    expect(noVar.status).toBe("preflight-blocked");
    expect(noVar.preflight.blocking.map((b) => [b.code, b.message])).toEqual([
      ["service.input-missing", expect.stringContaining("HALL_MONITOR_URL")],
    ]);
    expect(mutations(fake)).toHaveLength(0);
  });

  it("refuses config that does not fit the release", async () => {
    const release = await goldenRelease();
    expect(() => compileDesiredState(release.manifest, guardConfig(release, { enabled: true, vars: { ...GUARD_VARS, HALL_MONITOR_SIGNING_KEY: "x" } })))
      .toThrow("has no var input HALL_MONITOR_SIGNING_KEY");
    expect(() => compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { services: { "educateos-nope": { enabled: true } } })))
      .toThrow("release has no service educateos-nope");
    // Disabling needs only the Worker's name, so it compiles even for a release without the service.
    const desired = compileDesiredState(release.manifest, configFor(NORTHFIELD, release, { services: { "educateos-nope": { enabled: false } } }));
    expect(desired.resources.at(-2)).toMatchObject({ kind: "worker_retired", scriptName: "educateos-northfield-educateos-nope" });
  });
});

describe("rollback with services", () => {
  it("returns the backend to a version without the binding when the previous release had no guard", async () => {
    const withGuard = await goldenRelease();
    const r1 = await deriveRelease(withGuard, "r000000-noguard", (m) => {
      delete m.workers[GUARD];
    });
    const r2 = await deriveRelease(withGuard, "r000001-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r2\n"));
    const { fake, api, run } = setup();
    expect((await run(r1, undefined)).status).toBe("applied");
    expect((await run(r2, { enabled: true, vars: GUARD_VARS })).status).toBe("applied");

    const config = guardConfig(r2, { enabled: true, vars: GUARD_VARS });
    const { plan, deployed } = await rollback({ api, config, current: r2.manifest, previous: r1.manifest });

    expect(plan.blocked).toEqual([]);
    expect(plan.irreversible).toEqual(expect.arrayContaining([
      `${GUARD_SCRIPT} is new in r000001-fixture; rollback leaves it running`,
      `${BACKEND_SCRIPT} returns to a version without its AI_CALL_GUARD binding; the Worker it bound stays deployed`,
    ]));
    expect(deployed).toContain(BACKEND_SCRIPT);
    expect(guardBinding(fake)).toBeUndefined();
    expect(fake.worker(GUARD_SCRIPT)).toBeDefined();
  });

  it("blocks redeploying a backend version bound to a guard that has since been deleted", async () => {
    const r1 = await goldenRelease();
    const r2 = await deriveRelease(r1, "r000001-fixture", (m, a) => replaceModule(m, a, "router", "export default {}; // r2\n"));
    const { fake, api, run } = setup();
    await run(r1, { enabled: true, vars: GUARD_VARS });
    await run(r2, { enabled: true, vars: GUARD_VARS });
    await run(r2, { enabled: false });
    const before = mutations(fake).length;

    const config = guardConfig(r2, { enabled: false });
    const { plan } = await rollback({ api, config, current: r2.manifest, previous: r1.manifest, dryRun: true });

    expect(plan.blocked).toEqual([
      expect.objectContaining({ scriptName: BACKEND_SCRIPT, reason: expect.stringContaining(`binds AI_CALL_GUARD to ${GUARD_SCRIPT}, which is no longer deployed`) }),
    ]);
    await expect(rollback({ api, config, current: r2.manifest, previous: r1.manifest })).rejects.toThrow("rollback is blocked");
    expect(mutations(fake)).toHaveLength(before);
  });
});
