// Uninstall (SCHO-368): district offboarding removes a whole instance from the district's account,
// against the Cloudflare fake end to end. It deletes only what carries the instance's marker or the
// install's exact names, refuses without the instance ID as confirmation, never empties an R2
// bucket, and resumes after an interruption. Not yet run against a live account (SCHO-378).
import { describe, expect, it } from "vitest";
import {
  compileDesiredState,
  type FakeCloudflare,
  install,
  managedHostnameRecords,
  MARKER_VARS,
  planUninstall,
  R2_BUCKET_NOT_EMPTY_CODE,
  uninstall,
} from "../src/index.ts";
import { accountFor, configFor, goldenRelease, makeRoot, mutations, NORTHFIELD, SECRETS, type TestRelease, tokenFor } from "./support.ts";

const DISTRICT = "educateos-district-worker";
const DISTRICT_VARS = { DISTRICT_CONFIG: JSON.stringify({ synthetic: "the district's own config" }) };
const PREFIX = "educateos-northfield";

type Overrides = Record<string, unknown>;

/** A one-origin install of Northfield with the OSS admin and the managed hostname, the largest install there is. */
function fullConfig(release: TestRelease, overrides: Overrides = {}) {
  return configFor(NORTHFIELD, release, {
    services: { [DISTRICT]: { enabled: true, vars: DISTRICT_VARS } },
    admin: { enabled: true },
    managedHostname: { slug: "northfield" },
    ...overrides,
  });
}

async function installed(options: {
  overrides?: Overrides; fake?: FakeCloudflare; registry?: ReturnType<typeof makeRoot>; seeded?: string[];
} = {}) {
  const golden = await goldenRelease();
  // A release whose backend seeds bundled blueprints into BLUEPRINT_CONTENT lists their keys (SCHO-444).
  const release = options.seeded === undefined ? golden : { ...golden, manifest: structuredClone(golden.manifest) };
  if (options.seeded) release.manifest.workers["workshop-backend"]!.seededR2Objects = [{ binding: "BLUEPRINT_CONTENT", keys: options.seeded }];
  // The managed zone in the district's account: the same-account path, as the owner's districts use.
  const fake = options.fake ?? accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
  const api = fake.api(tokenFor(fake, "district-run").tokens);
  const config = fullConfig(release, options.overrides);
  const report = await install({
    api, config, manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS,
    ...(options.registry ? { registry: options.registry.endpoint } : {}),
  });
  expect(report.status).toBe("applied");
  const run = (extra: { dryRun?: boolean; confirm?: string } = {}) => uninstall({ api, config, manifest: release.manifest, ...extra });
  return { release, fake, api, config, run };
}

/** Everything the fake holds, in one comparable shape. */
function empty(fake: FakeCloudflare) {
  return Object.values(fake.inventory()).every((n) => n === 0);
}

describe("uninstall plan", () => {
  it("is a dry run by default that lists every resource the install made, in a safe order, and changes nothing", async () => {
    const { fake, run } = await installed();
    const before = mutations(fake).length;

    const report = await run();

    expect(report.status).toBe("planned");
    expect(mutations(fake)).toHaveLength(before);
    const { steps } = report.plan;
    expect(steps.every((s) => s.action === "delete")).toBe(true);
    // Hostnames, then Workers, then Access, then storage.
    const phases = steps.map((s) => s.phase);
    expect(phases).toEqual(phases.toSorted((a, b) => ["hostnames", "workers", "access", "storage", "dns"].indexOf(a) - ["hostnames", "workers", "access", "storage", "dns"].indexOf(b)));
    const keys = steps.map((s) => s.key);
    expect(keys).toContain("domain:managed");
    expect(keys).toContain("domain:educateos.northfield.example");
    expect(keys).toContain("domain:admin.northfield.example");
    expect(keys).toContain(`access:${PREFIX}`);
    expect(keys).toContain(`access:${PREFIX}-bypass`);
    expect(keys).toContain(`access:${PREFIX}-admin`);
    expect(keys).toContain(`access-policy:${PREFIX}-members`);
    expect(keys).toContain(`ai-gateway:${PREFIX}`);
    expect(keys.filter((k) => k.startsWith("worker:"))).toHaveLength(fake.inventory().workers);
    expect(keys.filter((k) => k.startsWith("kv:"))).toHaveLength(fake.inventory().kvNamespaces);
    expect(keys.filter((k) => k.startsWith("r2:"))).toHaveLength(fake.inventory().r2Buckets);
    expect(keys.filter((k) => k.startsWith("d1:"))).toHaveLength(1);
    // The router binds the backend and the district, so it goes before them.
    const workers = keys.filter((k) => k.startsWith("worker:"));
    expect(workers.indexOf(`worker:${PREFIX}-router`)).toBeLessThan(workers.indexOf(`worker:${PREFIX}-workshop-backend`));
    expect(report.plan.unclaimed).toEqual([]);
    expect(report.plan.registered).toBe(false);
  });

  it("refuses to apply without the instance ID as confirmation, and changes nothing", async () => {
    const { fake, run } = await installed();
    const before = mutations(fake).length;
    for (const confirm of [undefined, "", "northfield", "ins_riverbend", "INS_NORTHFIELD"]) {
      expect((await run({ dryRun: false, ...(confirm === undefined ? {} : { confirm }) })).status).toBe("refused");
    }
    expect(mutations(fake)).toHaveLength(before);
  });

  it("says when the install registered with a registry, whose record outlives the Workers", async () => {
    const { run } = await installed({ registry: makeRoot() });
    expect((await run()).plan.registered).toBe(true);
  });
});

describe("uninstall apply", () => {
  it("removes the whole instance with no leftovers, and a second run finds nothing to do", async () => {
    const { fake, run } = await installed();
    const order: string[] = [];
    fake.beforeMutation = (operation) => order.push(operation);

    const report = await run({ dryRun: false, confirm: "ins_northfield" });

    expect(report.status).toBe("removed");
    expect(report.result!.failed).toEqual([]);
    expect(report.leftovers).toEqual([]);
    expect(empty(fake)).toBe(true);
    // Nothing serves once the first phase is done, and storage goes only after every Worker.
    expect(fake.serving("educateos.northfield.example")).toBeUndefined();
    expect(fake.serving("northfield.educateos.io")).toBeUndefined();
    expect(order.lastIndexOf("deleteWorkerScript")).toBeLessThan(order.indexOf("deleteKvNamespace"));
    expect(order.lastIndexOf("detachWorkerDomain")).toBeLessThan(order.indexOf("deleteWorkerScript"));
    expect(order.lastIndexOf("deleteWorkerScript")).toBeLessThan(order.indexOf("deleteAccessApplication"));

    const before = mutations(fake).length;
    const again = await run({ dryRun: false, confirm: "ins_northfield" });
    expect(again.status).toBe("removed");
    expect(again.plan.steps.every((s) => s.action === "gone")).toBe(true);
    expect(mutations(fake)).toHaveLength(before);
  });

  it("never touches resources it can't prove are this instance's, and lists the prefixed ones for a person", async () => {
    const fake = accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
    const { run } = await installed({ fake });
    // A Worker, a namespace and an application sharing the prefix, but made by hand.
    fake.seedWorker(`${PREFIX}-hand-made`);
    fake.seedWorker(`${PREFIX}-other-instance`, { [MARKER_VARS.instance]: "ins_riverbend" });
    fake.seedKvNamespace(`${PREFIX}-notes`);
    fake.seedAccessApplication(`${PREFIX}-wiki`, "wiki.northfield.example");
    fake.seedAccessPolicy(`${PREFIX}-staff`);
    // And unrelated resources that merely start alike.
    fake.seedWorker("educateos-northfieldx-router", { [MARKER_VARS.instance]: "ins_northfield" });
    fake.seedKvNamespace("educateos-northfieldx-cache");

    const report = await run({ dryRun: false, confirm: "ins_northfield" });

    expect(report.plan.unclaimed.toSorted()).toEqual([
      `access-application:${PREFIX}-wiki`,
      `access-policy:${PREFIX}-staff`,
      `kv:${PREFIX}-notes`,
      `worker:${PREFIX}-hand-made`,
      `worker:${PREFIX}-other-instance`,
    ]);
    expect(report.status).toBe("removed");
    expect(report.leftovers!.toSorted()).toEqual(report.plan.unclaimed.toSorted());
    expect(fake.inventory()).toMatchObject({ workers: 3, kvNamespaces: 2, accessApplications: 1, accessPolicies: 1 });
    expect(fake.worker("educateos-northfieldx-router")).toBeDefined();
  });

  it("keeps a Worker with one of the instance's names that another instance or nobody deployed", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD);
    const api = fake.api(tokenFor(fake, "district-run").tokens);
    const config = configFor(NORTHFIELD, release);
    fake.seedWorker(`${PREFIX}-router`, { [MARKER_VARS.instance]: "ins_someone-else" });

    const report = await uninstall({ api, config, manifest: release.manifest, dryRun: false, confirm: "ins_northfield" });

    expect(report.plan.steps.find((s) => s.key === `worker:${PREFIX}-router`)).toMatchObject({ action: "keep" });
    expect(fake.worker(`${PREFIX}-router`)).toBeDefined();
    expect(report.status).toBe("removed");
    expect(report.leftovers).toEqual([`worker:${PREFIX}-router`]);
  });

  it("reports a non-empty R2 bucket instead of emptying it, deletes the rest, and finishes once the operator empties it", async () => {
    const { fake, config, release, run } = await installed();
    const bucket = compileDesiredState(release.manifest, config).resources.find((r) => r.kind === "r2_bucket")!;
    if (bucket.kind !== "r2_bucket") throw new Error("expected a bucket");
    fake.putR2Objects(bucket.name, 12, bucket.jurisdiction);

    const report = await run({ dryRun: false, confirm: "ins_northfield" });

    expect(report.status).toBe("incomplete");
    expect(report.result!.failed).toEqual([{ key: `r2:${bucket.name}`, reason: expect.stringContaining("still holds objects") }]);
    expect(report.result!.failed[0]!.reason).toContain(String(R2_BUCKET_NOT_EMPTY_CODE));
    expect(report.leftovers).toEqual([`r2:${bucket.name}`]);
    expect(fake.inventory()).toMatchObject({ workers: 0, kvNamespaces: 0, d1Databases: 0, r2Buckets: 1 });

    fake.emptyR2Bucket(bucket.name, bucket.jurisdiction);
    const finished = await run({ dryRun: false, confirm: "ins_northfield" });
    expect(finished.status).toBe("removed");
    expect(empty(fake)).toBe(true);
  });

  it("deletes exactly the objects the release seeded, before the bucket, and leaves a district's own (SCHO-444)", async () => {
    const seeded = [`educateos.tutor-k2/${"a".repeat(40)}`, `educateos.workspace-docs/${"b".repeat(40)}`];
    const { fake, config, release, run } = await installed({ seeded });
    const bucket = compileDesiredState(release.manifest, config).resources
      .find((r) => r.kind === "r2_bucket" && r.name.endsWith("-blueprint-content"))!;
    if (bucket.kind !== "r2_bucket") throw new Error("expected a bucket");
    expect(bucket.seededKeys).toEqual(seeded);
    // The backend seeded one of the two at first start, and a teacher published a blueprint.
    const published = `educateos.tutor-k2/${"c".repeat(40)}`;
    fake.putR2Objects(bucket.name, [seeded[0]!, published], bucket.jurisdiction);

    const plan = await run();
    const keys = plan.plan.steps.map((s) => s.key);
    expect(keys.indexOf(`r2-seeded:${bucket.name}`)).toBe(keys.indexOf(`r2:${bucket.name}`) - 1);
    expect(plan.plan.steps.find((s) => s.key === `r2-seeded:${bucket.name}`)).toMatchObject({
      action: "delete", target: { kind: "r2_seeded_objects", bucket: bucket.name, keys: seeded },
    });

    const report = await run({ dryRun: false, confirm: "ins_northfield" });
    // The published blueprint is the district's: it stays, so the bucket does too.
    expect(fake.r2ObjectKeys(bucket.name, bucket.jurisdiction)).toEqual([published]);
    expect(report.status).toBe("incomplete");
    expect(report.result!.deleted).toContain(`r2-seeded:${bucket.name}`);
    expect(report.result!.failed).toEqual([{ key: `r2:${bucket.name}`, reason: expect.stringContaining("objects the release didn't seed") }]);
    // One delete per listed key, the never-seeded one included (R2 deletes a missing key quietly).
    expect(fake.calls.filter((c) => c.operation === "deleteR2Object" && c.outcome === "ok")).toHaveLength(seeded.length);

    fake.emptyR2Bucket(bucket.name, bucket.jurisdiction);
    expect((await run({ dryRun: false, confirm: "ins_northfield" })).status).toBe("removed");
    expect(empty(fake)).toBe(true);
  });

  it("finishes in one run when the bucket holds only seeded objects", async () => {
    const seeded = [`educateos.tutor-k2/${"a".repeat(40)}`];
    const { fake, config, release, run } = await installed({ seeded });
    const bucket = compileDesiredState(release.manifest, config).resources
      .find((r) => r.kind === "r2_bucket" && r.name.endsWith("-blueprint-content"))!;
    if (bucket.kind !== "r2_bucket") throw new Error("expected a bucket");
    fake.putR2Objects(bucket.name, seeded, bucket.jurisdiction);
    expect((await run({ dryRun: false, confirm: "ins_northfield" })).status).toBe("removed");
    expect(empty(fake)).toBe(true);
  });

  it("stops before storage when a Worker can't be deleted, so no storage is removed from under a running Worker", async () => {
    const { fake, run } = await installed();
    // A Worker outside the install binds the backend, so Cloudflare refuses to delete the backend.
    fake.seedWorker("district-reporting");
    fake.editWorkerBindings("district-reporting", (b) => [...b, { type: "service", name: "WORKSHOP", service: `${PREFIX}-workshop-backend` }]);

    const report = await run({ dryRun: false, confirm: "ins_northfield" });

    expect(report.status).toBe("incomplete");
    expect(report.result!.failed).toEqual([{ key: `worker:${PREFIX}-workshop-backend`, reason: expect.stringContaining("another Worker still binds it") }]);
    expect(report.result!.notAttempted.some((k) => k.startsWith("kv:"))).toBe(true);
    expect(fake.inventory().kvNamespaces).toBeGreaterThan(0);
    expect(fake.inventory().accessApplications).toBeGreaterThan(0);
  });

  it("resumes after an interruption, whether or not the interrupted delete landed", async () => {
    for (const effectApplied of [true, false]) {
      const { fake, run } = await installed();
      fake.interruptMutation(7, { effectApplied });
      const first = await run({ dryRun: false, confirm: "ins_northfield" });
      expect(first.status).toBe("incomplete");
      expect(first.result!.failed).toHaveLength(1);
      expect(first.result!.failed[0]!.reason).toContain("no response from Cloudflare");

      const second = await run({ dryRun: false, confirm: "ins_northfield" });
      expect(second.status).toBe("removed");
      expect(empty(fake)).toBe(true);
    }
  });

  it("stops at once when the credential is revoked mid-run", async () => {
    const release = await goldenRelease();
    const fake = accountFor(NORTHFIELD, { zones: [{ name: "northfield.example" }, { name: "educateos.io" }] });
    const config = fullConfig(release);
    expect((await install({ api: fake.api(tokenFor(fake, "district-run").tokens), config, manifest: release.manifest, artifacts: release.artifacts, secrets: SECRETS })).status)
      .toBe("applied");
    const { token, tokens } = tokenFor(fake, "district-run");
    fake.beforeMutation = (_operation, ordinal) => {
      if (ordinal === mutations(fake).length + 1 && fake.calls.filter((c) => c.operation === "deleteWorkerScript").length === 2) fake.revokeToken(token);
    };

    await expect(uninstall({ api: fake.api(tokens), config, manifest: release.manifest, dryRun: false, confirm: "ins_northfield" }))
      .rejects.toMatchObject({ name: "InstallerHaltedError" });
    expect(fake.calls.filter((c) => c.outcome === "rejected")).toHaveLength(1);
  });
});

describe("uninstall, cross-account managed hostname", () => {
  it("deletes the custom hostname and route, and leaves the zone's shared fallback origin for a person", async () => {
    const fake = accountFor(NORTHFIELD, { saasZones: ["northfield.example"] });
    const { api, run } = await installed({ fake, overrides: { admin: { enabled: false } } });
    expect(fake.inventory()).toMatchObject({ customHostnames: 1, workerRoutes: 1 });
    expect(await managedHostnameRecords(api, "zone-0", "northfield.educateos.io")).toBeDefined();

    const report = await run({ dryRun: false, confirm: "ins_northfield" });

    expect(report.status).toBe("removed");
    expect(fake.inventory()).toMatchObject({ customHostnames: 0, workerRoutes: 0, workers: 0 });
    const origin = report.plan.steps.find((s) => s.phase === "dns")!;
    expect(origin).toMatchObject({ action: "keep", key: "dns:educateos-origin.northfield.example" });
    expect(fake.dnsNames()).toContain("educateos-origin.northfield.example");
    expect(report.leftovers).toEqual(["dns:educateos-origin.northfield.example"]);
  });
});

describe("uninstall plan observation", () => {
  it("reads nothing but listings and settings", async () => {
    const { fake, config, release, api } = await installed();
    const calls = fake.calls.length;
    await planUninstall(api, compileDesiredState(release.manifest, config));
    expect(fake.calls.slice(calls).every((c) => !c.mutation)).toBe(true);
    expect(new Set(fake.calls.slice(calls).map((c) => c.operation))).not.toContain("queryD1");
  });
});
