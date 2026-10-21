// The runner carries out what the adapter decided: one fresh container per job, the wall-clock
// bound, the output cap and the egress rule, and it always destroys the container.
import { describe, expect, it } from "vitest";
import type { RunnerJobRequest } from "@schoolos/assessment-ai/cloudflare-sandbox";
import { OOM_KILL_EXIT_CODE, REPORT_PATH, RunnerRequestError, WORK_DIR, runJob } from "../src/index.ts";
import { FakeJobContainer, type FakeProgram } from "./fake-container.ts";

function job(overrides: Partial<RunnerJobRequest> = {}): RunnerJobRequest {
  return {
    jobId: "asr_run:unit-tests",
    runtime: "python-3",
    instanceType: "lite",
    wallClockMs: 200,
    maxOutputBytes: 1024,
    egress: { kind: "none" },
    entrypoint: "tests/test_answer.py",
    files: [{ path: "art_answer", text: "def answer():\n    return 42\n" }],
    ...overrides,
  };
}

async function run(program: FakeProgram, overrides: Partial<RunnerJobRequest> = {}) {
  const container = new FakeJobContainer(program);
  const response = await runJob(job(overrides), container, { now: container.now });
  return { container, response };
}

describe("runJob", () => {
  it("runs the entrypoint under the runtime's harness and reports its tests", async () => {
    const { container, response } = await run(async (ctx) => {
      await ctx.spend(1500);
      await ctx.write("2 passed, 1 failed\n");
      ctx.report([{ name: "test_answer", passed: true }, { name: "test_types", passed: true }, { name: "test_edge", passed: false }]);
      return 1;
    });
    expect(response).toEqual({
      status: "completed",
      exitCode: 1,
      tests: [{ name: "test_answer", passed: true }, { name: "test_types", passed: true }, { name: "test_edge", passed: false }],
      outputBytes: 19,
      wallMs: 1500,
    });
    expect(container.started).toEqual({ instanceType: "lite", runtime: "python-3", allowHttpsHosts: [] });
    expect(container.files.get(`${WORK_DIR}/art_answer`)).toContain("return 42");
    expect(container.commands).toEqual([["/opt/schoolos/harness", "python3", "tests/test_answer.py"]]);
    expect(container.destroyed).toBe(true);
  });

  it("kills a job at its wall-clock bound", async () => {
    const { container, response } = await run(async (ctx) => {
      for (;;) await ctx.spend(10);
    }, { wallClockMs: 30 });
    expect(response).toMatchObject({ status: "limit-exceeded", limit: "wall-clock" });
    expect(container.destroyed).toBe(true);
  });

  it("stops a job once its output passes the cap, without reading the rest", async () => {
    let written = 0;
    const { response } = await run(async (ctx) => {
      for (;;) {
        await ctx.write("x".repeat(256));
        written += 256;
      }
    }, { maxOutputBytes: 1000 });
    expect(response).toMatchObject({ status: "limit-exceeded", limit: "output" });
    expect(written).toBeLessThanOrEqual(1280);
  });

  it("applies the egress rule: none reaches nothing, an allowlist only its hosts", async () => {
    const tryHosts: FakeProgram = async (ctx) => {
      ctx.connect("data.example");
      return 0;
    };
    expect((await run(tryHosts)).response).toMatchObject({ status: "limit-exceeded", limit: "network" });
    const allowed = await run(tryHosts, { egress: { kind: "allowlist", hosts: ["data.example"] } });
    expect(allowed.response).toMatchObject({ status: "completed", exitCode: 0 });
    expect(allowed.container.started?.allowHttpsHosts).toEqual(["data.example"]);
    const elsewhere = await run(async (ctx) => (ctx.connect("exfil.example") ? 0 : 1), { egress: { kind: "allowlist", hosts: ["data.example"] } });
    expect(elsewhere.response).toMatchObject({ status: "limit-exceeded", limit: "network" });
  });

  it("reads an out-of-memory kill as the memory limit", async () => {
    expect((await run(async () => OOM_KILL_EXIT_CODE)).response).toMatchObject({ status: "limit-exceeded", limit: "memory" });
  });

  it("ignores a report the program could forge or garble, keeping only the exit code", async () => {
    const garbled = await run(async (ctx) => {
      ctx.files.set(REPORT_PATH, "{not json");
      return 0;
    });
    expect(garbled.response).toMatchObject({ status: "completed", tests: [] });
    const long = await run(async (ctx) => {
      ctx.report([{ name: "t".repeat(500), passed: true }]);
      return 0;
    });
    expect(long.response).toMatchObject({ status: "completed", tests: [{ name: "t".repeat(200), passed: true }] });
  });

  it("refuses paths outside the work directory before starting anything", async () => {
    for (const bad of [{ entrypoint: "../etc/passwd" }, { entrypoint: "/bin/sh" }, { files: [{ path: "a/../../b", text: "" }] }, { files: [{ path: "./a", text: "" }] }]) {
      const container = new FakeJobContainer(async () => 0);
      await expect(runJob(job(bad), container)).rejects.toBeInstanceOf(RunnerRequestError);
      expect(container.started).toBeUndefined();
    }
  });

  it("destroys the container even when it could not start", async () => {
    const container = new FakeJobContainer(async () => 0);
    container.failStart = true;
    await expect(runJob(job(), container)).rejects.toThrow("no capacity");
    expect(container.destroyed).toBe(true);
  });
});
