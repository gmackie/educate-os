import { describe, expect, it } from "vitest";
import { FakeExecutionSandbox, SANDBOX_UNAVAILABLE_REASON, unavailableSandbox, type CiSandboxProfile, type FakeProgram, type SandboxJob } from "../src/index.ts";
import { P, SANDBOX_PROFILE, rejectsWith, setup } from "./setup.ts";

/** Runs the essay's tests: three pass, one fails. */
const TESTS: FakeProgram = (ctx) => {
  ctx.cpu(300);
  ctx.allocate(64);
  for (const [name, passed] of [["has-title", true], ["has-sections", true], ["cites-sources", true], ["under-limit", false]] as const) ctx.test(name, passed);
  ctx.write("4 tests run\n");
  return 1;
};

const PROGRAMS: Record<string, FakeProgram> = {
  "tests/essay.py": TESTS,
  "tests/visible.py": (ctx) => {
    ctx.cpu(100);
    ctx.test("runs", true);
  },
  "tests/spin.py": (ctx) => {
    for (;;) ctx.cpu(250);
  },
  "tests/hog.py": (ctx) => ctx.allocate(1024),
  "tests/chatty.py": (ctx) => {
    for (;;) ctx.write("x".repeat(1000));
  },
  "tests/phone-home.py": (ctx) => ctx.connect("collector.example"),
  "tests/fetch-data.py": (ctx) => {
    ctx.connect("data.example");
    ctx.test("downloaded", true);
  },
  "tests/expensive.py": (ctx) => ctx.cpu(1500),
};

function job(entrypoint: string, profile: Partial<CiSandboxProfile> = {}, remainingCostCents = 10): SandboxJob {
  return { jobId: "asr_test:check", entrypoint, files: [], profile: { ...SANDBOX_PROFILE.sandbox, ...profile }, remainingCostCents };
}

const checks = [
  { id: "hidden-tests", criterionId: "structure", entrypoint: "tests/essay.py", visibility: "teacher-only" as const },
  { id: "smoke", criterionId: "structure", entrypoint: "tests/visible.py", visibility: "student-visible" as const },
];

describe("the execution sandbox", () => {
  it("is unavailable by default, and a sandboxed run fails closed", async () => {
    expect(unavailableSandbox().availability()).toEqual({ available: false, reason: SANDBOX_UNAVAILABLE_REASON });
    const env = await setup();
    const run = await env.ai.runSandbox(P.rivera, { submissionId: env.submissionId, idempotencyKey: "tests", executionProfile: "sandbox-tests@1", checks });
    expect(run).toMatchObject({ state: "failed", error: { code: "sandbox-unavailable", message: SANDBOX_UNAVAILABLE_REASON } });
    expect(run.report).toBeUndefined();
  });

  it("does not run where the district plan lacks it, even with a sandbox configured", async () => {
    const sandbox = new FakeExecutionSandbox(PROGRAMS);
    const env = await setup({ plan: { sandbox: "unavailable" }, sandbox });
    const run = await env.ai.runSandbox(P.rivera, { submissionId: env.submissionId, idempotencyKey: "tests", executionProfile: "sandbox-tests@1", checks });
    expect(run).toMatchObject({ state: "failed", error: { code: "sandbox-unavailable" } });
    expect(sandbox.jobs).toEqual([]);
  });

  it("runs the teacher's checks in isolation on the submitted files and reports evidence, not output", async () => {
    const sandbox = new FakeExecutionSandbox(PROGRAMS);
    const env = await setup({ sandbox });
    const run = await env.ai.runSandbox(P.rivera, { submissionId: env.submissionId, idempotencyKey: "tests", executionProfile: "sandbox-tests@1", checks });
    expect(run.state).toBe("completed");
    expect(sandbox.jobs.map((j) => [j.jobId, j.files.map((f) => f.path), j.profile.egress])).toEqual([
      [`${run.id}:hidden-tests`, [env.essay.artifact.id], { kind: "none" }],
      [`${run.id}:smoke`, [env.essay.artifact.id], { kind: "none" }],
    ]);
    expect(run.report?.kind === "sandbox" && run.report.checks.map((c) => [c.checkId, c.visibility, c.evidence.observation, c.evidence.passed, c.evidence.score])).toEqual([
      ["hidden-tests", "teacher-only", "3 of 4 tests passed", false, 0.75],
      ["smoke", "student-visible", "1 of 1 tests passed", true, 1],
    ]);
    expect(JSON.stringify(run.report)).not.toContain("4 tests run");
    // Each job is charged whole cents, rounded up.
    expect(run.report?.kind === "sandbox" && run.report.costCents).toBe(2);
  });

  it("enforces CPU time, memory, output size, egress and cost in the fake", async () => {
    const sandbox = new FakeExecutionSandbox(PROGRAMS, { centsPerCpuSecond: 4 });
    expect(await sandbox.run(job("tests/spin.py"))).toMatchObject({ status: "limit-exceeded", limit: "cpu", cpuMs: 2000 });
    expect(await sandbox.run(job("tests/hog.py"))).toMatchObject({ status: "limit-exceeded", limit: "memory" });
    expect(await sandbox.run(job("tests/chatty.py"))).toMatchObject({ status: "limit-exceeded", limit: "output" });
    expect(await sandbox.run(job("tests/phone-home.py"))).toMatchObject({ status: "limit-exceeded", limit: "network" });
    // An allowlist opens only the hosts it names.
    const allow = { egress: { kind: "allowlist" as const, hosts: ["data.example"] } };
    expect(await sandbox.run(job("tests/fetch-data.py", allow))).toMatchObject({ status: "completed", tests: [{ name: "downloaded", passed: true }] });
    expect(await sandbox.run(job("tests/phone-home.py", allow))).toMatchObject({ status: "limit-exceeded", limit: "network" });
    // 1.5 s at 4 cents a second is 6 cents: within a 10-cent run, not within the 5 cents left.
    expect(await sandbox.run(job("tests/expensive.py"))).toMatchObject({ status: "completed", costCents: 6 });
    expect(await sandbox.run(job("tests/expensive.py", {}, 5))).toMatchObject({ status: "limit-exceeded", limit: "cost", costCents: 5 });
  });

  it("charges every check against one per-run cost limit", async () => {
    const sandbox = new FakeExecutionSandbox(PROGRAMS, { centsPerCpuSecond: 4 });
    const env = await setup({ sandbox });
    const twice = ["a", "b"].map((id) => ({ id, criterionId: "structure", entrypoint: "tests/expensive.py", visibility: "teacher-only" as const }));
    const run = await env.ai.runSandbox(P.rivera, { submissionId: env.submissionId, idempotencyKey: "costly", executionProfile: "sandbox-tests@1", checks: twice });
    expect(sandbox.jobs.map((j) => j.remainingCostCents)).toEqual([10, 4]);
    expect(run.report?.kind === "sandbox" && run.report.checks.map((c) => c.limit ?? "ok")).toEqual(["ok", "cost"]);
    expect(run.report?.kind === "sandbox" && run.report.costCents).toBe(10);
  });

  it("refuses a sandbox that reports beyond its limits", async () => {
    const lying = { availability: () => ({ available: true as const }), run: async () => ({ status: "completed" as const, exitCode: 0, tests: [], outputBytes: 0, cpuMs: 999_999, costCents: 0 }) };
    const env = await setup({ sandbox: lying });
    const run = await env.ai.runSandbox(P.rivera, { submissionId: env.submissionId, idempotencyKey: "tests", executionProfile: "sandbox-tests@1", checks });
    expect(run).toMatchObject({ state: "failed", error: { code: "sandbox-error" } });
  });

  it("is started only by the teacher acting directly", async () => {
    const env = await setup({ sandbox: new FakeExecutionSandbox(PROGRAMS) });
    const request = { submissionId: env.submissionId, idempotencyKey: "tests", executionProfile: "sandbox-tests@1", checks };
    await rejectsWith(env.ai.runSandbox(P.amara, request), "forbidden");
    await rejectsWith(env.ai.runSandbox(P.riveraTool, request), "forbidden");
    await rejectsWith(env.ai.runSandbox(P.rivera, { ...request, checks: [{ ...checks[0]!, entrypoint: "../etc/passwd" }] }), "validation-failed");
  });
});
