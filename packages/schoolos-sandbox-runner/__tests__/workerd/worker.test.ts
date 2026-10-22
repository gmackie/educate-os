// The runner Worker and its per-job Durable Object on the Workers runtime: only `POST /v1/jobs`
// with a well-formed job is accepted, a job runs at most once however often it is retried (at
// once, or after the object restarts), and a job ID never names two different jobs.

import { SELF, env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { RunnerJobResponse, type RunnerJobRequest } from "@schoolos/assessment-ai/cloudflare-sandbox";

let jobs = 0;

function job(overrides: Partial<RunnerJobRequest> = {}): RunnerJobRequest {
  return {
    jobId: `asr_run-${jobs++}:unit-tests`,
    runtime: "python-3",
    instanceType: "lite",
    wallClockMs: 5000,
    maxOutputBytes: 1024,
    egress: { kind: "none" },
    entrypoint: "tests/test_answer.py",
    files: [{ path: "art_answer", text: "def answer():\n    return 42\n" }],
    ...overrides,
  };
}

const post = (body: unknown, path = "/v1/jobs") =>
  SELF.fetch(`https://sandbox-runner.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const starts = (jobId: string) => runInDurableObject(env.JOBS.getByName(jobId), async (instance) => instance.starts);

describe("the runner Worker", () => {
  it("runs a job and answers with a RunnerJobResponse the adapter accepts", async () => {
    const response = await post(job());
    expect(response.status).toBe(200);
    expect(RunnerJobResponse.parse(await response.json())).toMatchObject({ status: "completed", exitCode: 0, tests: [{ name: "test_answer", passed: true }], outputBytes: 3 });
  });

  it("accepts only POST /v1/jobs with a well-formed job", async () => {
    expect((await SELF.fetch("https://sandbox-runner.internal/v1/jobs")).status).toBe(405);
    expect((await post(job(), "/admin")).status).toBe(404);
    expect((await post({ ...job(), extra: true })).status).toBe(400);
    expect((await post(job({ entrypoint: "../../etc/passwd" }))).status).toBe(400);
    const notJson = await SELF.fetch("https://sandbox-runner.internal/v1/jobs", { method: "POST", body: "{" });
    expect(notJson.status).toBe(400);
  });

  it("runs a job once however often it is retried, at once or after a restart", async () => {
    const request = job();
    const [first, second] = await Promise.all([post(request), post(request)]);
    const answer = await first.json();
    expect(await second.json()).toEqual(answer);
    expect(await starts(request.jobId)).toBe(1);

    await evictDurableObject(env.JOBS.getByName(request.jobId));
    expect(await (await post(request)).json()).toEqual(answer);
    // The restarted object answered from storage and started nothing.
    expect(await starts(request.jobId)).toBe(0);
  });

  it("refuses a different job under a job ID already used", async () => {
    const request = job();
    await post(request);
    const reused = await post({ ...request, entrypoint: "tests/other.py" });
    expect(reused.status).toBe(409);
  });
});
