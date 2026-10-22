// The adapter in @schoolos/assessment-ai and this runner speak the same protocol: a job the adapter
// sends through the Worker comes back as a sandbox result the assessment service accepts, with the
// adapter's limits applied to what the runner observed.
import { describe, expect, it } from "vitest";
import { createCloudflareSandbox, SandboxResult, type CiSandboxProfile, type SandboxJob as AdapterJob } from "@schoolos/assessment-ai";
import { SandboxJob, runnerWorker, type JobContainer, type JobObjectState, type RunnerEnv } from "../src/index.ts";
import { FakeJobContainer, type FakeProgram } from "./fake-container.ts";

const ENDPOINT = "https://sandbox-runner.internal/v1/jobs";

/** Fresh in-memory storage for one job object. */
function storage(): JobObjectState["storage"] {
  const values = new Map<string, unknown>();
  return { get: async (key) => structuredClone(values.get(key)), put: async (key, value) => void values.set(key, structuredClone(value)) };
}

/** The Worker over in-memory job objects whose containers run `program`. */
function runner(program: FakeProgram) {
  const containers: FakeJobContainer[] = [];
  class InMemoryJob extends SandboxJob {
    protected override container(): JobContainer {
      const container = new FakeJobContainer(program);
      containers.push(container);
      return container;
    }
  }
  const objects = new Map<string, InMemoryJob>();
  const env: RunnerEnv = {
    JOBS: {
      getByName: (name) => {
        let object = objects.get(name);
        if (object === undefined) objects.set(name, (object = new InMemoryJob({ storage: storage() }, {})));
        return object;
      },
    },
  };
  const fetch = ((input: string | URL | Request, init?: RequestInit) => runnerWorker.fetch(new Request(input, init), env)) as typeof globalThis.fetch;
  return { sandbox: createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch }), containers };
}

// Five cents, in nanodollars (ADR-0008).
const PROFILE: CiSandboxProfile = { runtime: "python-3", cpuMs: 10_000, memoryMb: 256, maxOutputBytes: 4096, egress: { kind: "allowlist", hosts: ["data.example"] }, maxCostUsdNano: "50000000" };

const job = (profile: Partial<CiSandboxProfile> = {}): AdapterJob => ({
  jobId: "asr_run:hidden-tests",
  entrypoint: "tests/test_answer.py",
  files: [{ path: "art_answer", text: "def answer():\n    return 42\n" }],
  profile: { ...PROFILE, ...profile },
  remainingCostUsdNano: "50000000",
});

describe("createCloudflareSandbox against the runner", () => {
  it("completes a job end to end with the instance, egress rule and files the adapter chose", async () => {
    const { sandbox, containers } = runner(async (ctx) => {
      ctx.connect("data.example");
      await ctx.write("3 passed\n");
      ctx.report([{ name: "a", passed: true }, { name: "b", passed: true }, { name: "c", passed: true }]);
      return 0;
    });
    const result = SandboxResult.parse(await sandbox.run(job()));
    expect(result).toMatchObject({ status: "completed", exitCode: 0, tests: [{ name: "a", passed: true }, { name: "b", passed: true }, { name: "c", passed: true }], outputBytes: 9 });
    expect(containers[0]?.started).toEqual({ instanceType: "lite", runtime: "python-3", allowHttpsHosts: ["data.example"] });
    expect(containers[0]?.destroyed).toBe(true);
  });

  it("reports the runner's limits in the adapter's terms", async () => {
    const network = runner(async (ctx) => (ctx.connect("exfil.example") ? 0 : 1));
    expect(await network.sandbox.run(job())).toMatchObject({ status: "limit-exceeded", limit: "network" });
    const output = runner(async (ctx) => {
      for (;;) await ctx.write("x".repeat(1024));
    });
    expect(await output.sandbox.run(job({ maxOutputBytes: 2048 }))).toMatchObject({ status: "limit-exceeded", limit: "output" });
  });

  it("runs a retried job once", async () => {
    const { sandbox, containers } = runner(async () => 0);
    const first = await sandbox.run(job());
    expect(await sandbox.run(job())).toEqual(first);
    expect(containers).toHaveLength(1);
  });
});
