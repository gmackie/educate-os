// `DurableObjectOptionalRunStore` in workerd, against real Durable Object SQLite storage: runs and
// their records survive a restart, exactly one of several concurrent claims wins, a run's history
// cannot be rewritten, and overrides and releases are append-only.

import { env, evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AiRelease, OptionalRun, TeacherOverride } from "../../src/index.ts";

let objects = 0;
const fresh = () => env.OPTIONAL_RUNS.getByName(`district-${objects++}`);

const SUBMISSION = "sub_amara-night" as OptionalRun["submissionId"];

function run(id: string, queuedAt = "2026-10-20T12:00:00.000Z"): OptionalRun {
  return {
    id: id as OptionalRun["id"],
    key: {
      submissionDigest: `sha256:${"a".repeat(64)}` as OptionalRun["key"]["submissionDigest"],
      rubricRelease: { rubricId: "rbr_night-essay" as OptionalRun["key"]["rubricRelease"]["rubricId"], version: 1 },
      evaluatorRelease: `sha256:${"b".repeat(64)}` as OptionalRun["key"]["evaluatorRelease"],
      executionProfile: "ai-feedback@1",
      idempotencyKey: id,
    },
    spec: { kind: "ai", evaluator: { id: "ai.feedback", release: "1.0.0" }, model: { provider: "anthropic", modelId: "claude-example" }, config: {} },
    submissionId: SUBMISSION,
    districtId: "dst_northfield" as OptionalRun["districtId"],
    offeringId: "off_nf-eng9-fall-p3" as OptionalRun["offeringId"],
    activityId: "act_night-essay" as OptionalRun["activityId"],
    requestedBy: "prn_nf-teacher-rivera" as OptionalRun["requestedBy"],
    state: "queued",
    revision: 0,
    attempts: 0,
    queuedAt,
  };
}

const claim = (r: OptionalRun, startedAt: string): OptionalRun => ({ ...r, state: "running", attempts: r.attempts + 1, startedAt, revision: r.revision + 1 });

const override = (reason: string): TeacherOverride => ({
  submissionId: SUBMISSION,
  runId: "asr_one" as TeacherOverride["runId"],
  criterionId: "argument",
  override: { decision: "reject" },
  reason,
  decidedBy: "prn_nf-teacher-rivera" as TeacherOverride["decidedBy"],
  decidedAt: "2026-10-20T12:10:00.000Z",
  channel: "http",
});

describe("DurableObjectOptionalRunStore", () => {
  it("keeps runs, overrides and releases across a restart, oldest first", async () => {
    const store = fresh();
    const later = await store.insertRun(run("asr_two", "2026-10-20T12:05:00.000Z"));
    const first = await store.insertRun(run("asr_one"));
    expect(await store.insertRun({ ...first, requestedBy: "prn_nf-teacher-chen" as OptionalRun["requestedBy"] })).toEqual(first);
    await store.addOverride(override("Misreads the conclusion."));
    await store.addOverride(override("Second look: still off."));
    const release: AiRelease = { submissionId: SUBMISSION, runId: first.id, releasedBy: first.requestedBy, releasedAt: "2026-10-20T12:20:00.000Z", channel: "http" };
    await store.addRelease(release);
    await store.addRelease({ ...release, releasedAt: "2026-10-21T09:00:00.000Z" });

    await evictDurableObject(store);
    expect((await store.runsFor(SUBMISSION)).map((r) => r.id)).toEqual([first.id, later.id]);
    expect((await store.overridesFor(SUBMISSION)).map((o) => o.reason)).toEqual(["Misreads the conclusion.", "Second look: still off."]);
    expect(await store.releasesFor(SUBMISSION)).toEqual([release]);
    expect(await store.runsFor("sub_other" as OptionalRun["submissionId"])).toEqual([]);
  });

  it("lets exactly one of ten concurrent claims from the same revision win, and keeps history", async () => {
    const store = fresh();
    const queued = await store.insertRun(run("asr_contended"));
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.replaceRun(claim(queued, `2026-10-20T12:00:0${i}.000Z`), 0)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "conflict")).toHaveLength(9);
    const running = await store.getRun(queued.id);
    expect(await store.replaceRun({ ...running!, state: "queued", revision: 2, requestedBy: "prn_nf-teacher-chen" as OptionalRun["requestedBy"] }, 1)).toEqual({ ok: false, code: "policy-violation" });
    expect(await store.getRun(queued.id)).toEqual(running);
  });

  it("refuses any rewrite of recorded overrides at the storage layer", async () => {
    const store = fresh();
    await store.addOverride(override("Kept."));
    expect(await store.rewriteOverrides()).toMatch(/append-only/);
    expect((await store.overridesFor(SUBMISSION)).map((o) => o.reason)).toEqual(["Kept."]);
  });
});
