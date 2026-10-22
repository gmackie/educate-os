// `DurableObjectAssessmentRunStore` in workerd, against real Durable Object SQLite storage: runs
// survive a restart, inserting is first-wins, exactly one of several concurrent claims wins, a run's
// history cannot be rewritten, and the queue finds queued runs and expired leases.

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AssessmentRun } from "../../src/index.ts";

let objects = 0;
const fresh = () => env.RUNS.getByName(`district-${objects++}`);

function run(id: string, queuedAt = "2026-10-20T12:00:00.000Z"): AssessmentRun {
  return {
    id: id as AssessmentRun["id"],
    key: {
      submissionDigest: `sha256:${"a".repeat(64)}` as AssessmentRun["key"]["submissionDigest"],
      rubricRelease: { rubricId: "rbr_bio-lab" as AssessmentRun["key"]["rubricRelease"]["rubricId"], version: 1 },
      evaluatorRelease: `sha256:${"b".repeat(64)}` as AssessmentRun["key"]["evaluatorRelease"],
      executionProfile: "deterministic@1",
      idempotencyKey: id,
    },
    evaluators: [{ id: "dataset.structure", release: "1.0.0" }],
    state: "queued",
    revision: 0,
    attempts: 0,
    queuedAt,
  };
}

const claim = (r: AssessmentRun, startedAt: string): AssessmentRun => ({ ...r, state: "running", attempts: r.attempts + 1, startedAt, revision: r.revision + 1 });

describe("DurableObjectAssessmentRunStore", () => {
  it("keeps runs across a restart, and the first insert wins", async () => {
    const runs = fresh();
    const first = run("asr_one");
    expect(await runs.insert(first)).toEqual(first);
    expect(await runs.insert({ ...first, queuedAt: "2026-10-21T00:00:00.000Z" })).toEqual(first);
    await evictDurableObject(runs);
    expect(await runs.get(first.id)).toEqual(first);
    expect(await runs.get("asr_missing" as AssessmentRun["id"])).toBeUndefined();
  });

  it("lets exactly one of ten concurrent claims from the same revision win", async () => {
    const runs = fresh();
    const queued = await runs.insert(run("asr_contended"));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runs.replace(claim(queued, `2026-10-20T12:00:0${i}.000Z`), 0)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "conflict")).toHaveLength(9);
    expect(await runs.get(queued.id)).toMatchObject({ state: "running", revision: 1, attempts: 1 });
  });

  it("refuses to rewrite a run's history", async () => {
    const runs = fresh();
    const queued = await runs.insert(run("asr_history"));
    expect(await runs.replace({ ...queued, state: "failed", error: { code: "integrity", message: "skipped ahead" }, revision: 1 }, 0)).toEqual({ ok: false, code: "policy-violation" });
    expect(await runs.replace({ ...claim(queued, "2026-10-20T12:00:00.000Z"), key: { ...queued.key, idempotencyKey: "other" } }, 0)).toEqual({ ok: false, code: "policy-violation" });
    expect(await runs.replace(claim(queued, "2026-10-20T12:00:00.000Z"), 7)).toEqual({ ok: false, code: "conflict" });
    expect(await runs.get(queued.id)).toEqual(queued);
  });

  it("queues runs that are waiting and runs whose lease expired, oldest first", async () => {
    const runs = fresh();
    const waiting = await runs.insert(run("asr_waiting", "2026-10-20T12:02:00.000Z"));
    const abandoned = await runs.insert(run("asr_abandoned", "2026-10-20T12:00:00.000Z"));
    const active = await runs.insert(run("asr_active", "2026-10-20T12:01:00.000Z"));
    await runs.replace(claim(abandoned, "2026-10-20T12:00:30.000Z"), 0);
    await runs.replace(claim(active, "2026-10-20T12:09:00.000Z"), 0);

    const due = await runs.runnable("2026-10-20T12:05:00.000Z", 10);
    expect(due.map((r) => r.id)).toEqual([abandoned.id, waiting.id]);
    expect((await runs.runnable("2026-10-20T12:05:00.000Z", 1)).map((r) => r.id)).toEqual([abandoned.id]);
    await evictDurableObject(runs);
    expect((await runs.runnable("2026-10-20T12:10:00.000Z", 10)).map((r) => r.id)).toEqual([abandoned.id, active.id, waiting.id]);
  });
});
