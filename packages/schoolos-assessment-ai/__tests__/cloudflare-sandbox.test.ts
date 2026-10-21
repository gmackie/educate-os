import { usdNanoFromCents } from "@schoolos/contracts";
import { describe, expect, it } from "vitest";
import {
  assessmentPlanFromPack,
  CLOUDFLARE_SANDBOX_DISABLED_REASON,
  CLOUDFLARE_SANDBOX_FLAG,
  cloudflareSandboxEnabled,
  createCloudflareSandbox,
  RunnerJobRequest,
  type CiSandboxProfile,
  type SandboxJob,
} from "../src/index.ts";
import { SANDBOX_PROFILE } from "./setup.ts";

const ENDPOINT = "https://sandbox-runner.internal.example/v1/jobs";

/** A fake runner Worker: records each request and answers with `reply`. */
function fakeRunner(reply: (request: RunnerJobRequest) => Response | Promise<Response>) {
  const requests: RunnerJobRequest[] = [];
  const handler = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(ENDPOINT);
    const request = RunnerJobRequest.parse(JSON.parse(String(init?.body)));
    requests.push(request);
    return reply(request);
  };
  return { fetch: handler as typeof fetch, requests };
}

const completed = (extra: Record<string, unknown> = {}) =>
  Response.json({ status: "completed", exitCode: 0, tests: [{ name: "runs", passed: true }], outputBytes: 12, wallMs: 4000, ...extra });

function job(profile: Partial<CiSandboxProfile> = {}, remainingCostUsdNano = usdNanoFromCents(10)): SandboxJob {
  return {
    jobId: "asr_test:check",
    entrypoint: "tests/run.py",
    files: [{ path: "a1", text: "print('hi')" }],
    profile: { ...SANDBOX_PROFILE.sandbox, ...profile },
    remainingCostUsdNano,
  };
}

describe("createCloudflareSandbox", () => {
  it("is off unless the flag is exactly `on`, and then never calls the runner", async () => {
    expect(cloudflareSandboxEnabled({ [CLOUDFLARE_SANDBOX_FLAG]: "true" })).toBe(false);
    expect(cloudflareSandboxEnabled({})).toBe(false);
    expect(cloudflareSandboxEnabled({ [CLOUDFLARE_SANDBOX_FLAG]: "on" })).toBe(true);
    const runner = fakeRunner(() => completed());
    const sandbox = createCloudflareSandbox({ enabled: false, endpoint: ENDPOINT, fetch: runner.fetch });
    expect(sandbox.availability()).toEqual({ available: false, reason: CLOUDFLARE_SANDBOX_DISABLED_REASON });
    expect(await sandbox.run(job())).toMatchObject({ status: "unavailable" });
    expect(runner.requests).toEqual([]);
  });

  it("picks the smallest instance with enough memory and a wall-clock bound that caps CPU time", async () => {
    const runner = fakeRunner(() => completed());
    const sandbox = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: runner.fetch });
    const result = await sandbox.run(job({ memoryMb: 1000, cpuMs: 2000, egress: { kind: "allowlist", hosts: ["data.example"] } }));
    expect(runner.requests[0]).toMatchObject({
      jobId: "asr_test:check",
      instanceType: "basic",
      // basic has 1/4 vCPU, so 8 s of wall clock is at most 2 s of CPU.
      wallClockMs: 8000,
      egress: { kind: "allowlist", hosts: ["data.example"] },
      files: [{ path: "a1", text: "print('hi')" }],
    });
    expect(result).toMatchObject({ status: "completed", exitCode: 0, cpuMs: 1000, costUsdNano: "30000" });
  });

  it("shortens the bound to what the run's remaining cost allows, and refuses a job it cannot afford", async () => {
    const runner = fakeRunner(() => completed({ wallMs: 1 }));
    const sandbox = createCloudflareSandbox({
      enabled: true,
      endpoint: ENDPOINT,
      fetch: runner.fetch,
      pricing: { usdNanoPerVcpuSecond: usdNanoFromCents(1), usdNanoPerGibSecond: "0" },
    });
    await sandbox.run(job({ memoryMb: 256, cpuMs: 600_000 }, usdNanoFromCents(1)));
    // lite: 1/16 cent per second, so 1 cent buys 16 s, well under the CPU bound.
    expect(runner.requests[0]?.wallClockMs).toBe(16_000);
    expect(await sandbox.run(job({}, "0"))).toMatchObject({ status: "limit-exceeded", limit: "cost" });
    expect(runner.requests).toHaveLength(1);
  });

  it("maps the runner's wall-clock limit to the limit that set the bound", async () => {
    const sandbox = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner((r) => Response.json({ status: "limit-exceeded", limit: "wall-clock", wallMs: r.wallClockMs })).fetch });
    expect(await sandbox.run(job())).toMatchObject({ status: "limit-exceeded", limit: "cpu", cpuMs: 2000 });
  });

  it("does not trust a runner that ran past its bound or over-reports output", async () => {
    const late = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner((r) => completed({ wallMs: r.wallClockMs + 1 })).fetch });
    expect(await late.run(job())).toMatchObject({ status: "limit-exceeded", limit: "cpu", cpuMs: 2000 });
    const chatty = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner(() => completed({ outputBytes: 1_000_000 })).fetch });
    expect(await chatty.run(job())).toMatchObject({ status: "limit-exceeded", limit: "output" });
  });

  it("throws on a runner failure or a malformed answer, so the run retries", async () => {
    const down = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner(() => new Response("", { status: 503 })).fetch });
    await expect(down.run(job())).rejects.toMatchObject({ code: "unavailable" });
    const extra = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner(() => completed({ grade: "A" })).fetch });
    await expect(extra.run(job())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("passes no runner text through to the result", async () => {
    const sandbox = createCloudflareSandbox({ enabled: true, endpoint: ENDPOINT, fetch: fakeRunner(() => Response.json({ status: "limit-exceeded", limit: "network", wallMs: 10 })).fetch });
    expect(await sandbox.run(job())).toMatchObject({ status: "limit-exceeded", limit: "network", detail: "The job tried to reach a host its profile does not allow." });
  });
});

describe("assessmentPlanFromPack", () => {
  it("offers the sandbox only when the pack declares it and the district provisioned it", () => {
    const pack = { optionalResources: ["ci-sandbox", "ai-gateway"] as const };
    expect(assessmentPlanFromPack({ optionalResources: [...pack.optionalResources] }, ["ci-sandbox"])).toEqual({ sandbox: "available" });
    expect(assessmentPlanFromPack({ optionalResources: [...pack.optionalResources] }, ["ai-gateway"])).toEqual({ sandbox: "unavailable" });
    expect(assessmentPlanFromPack({ optionalResources: ["ai-gateway"] }, ["ci-sandbox"])).toEqual({ sandbox: "unavailable" });
    expect(assessmentPlanFromPack({}, ["ci-sandbox"])).toEqual({ sandbox: "unavailable" });
  });
});
