import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectCourseIntentDraftStore, DISTRICT_TABLES } from "@educateos/district-app/durable-stores";
import { CourseIntentDraftRecord } from "@educateos/district-app/routes";

let next = 0;
const fresh = () => env.DISTRICT.getByName("private-ai-drafts-" + next++);
const source = {
  packageId: "example.org/science",
  version: "1.0.0",
  digest: "sha256:" + "a".repeat(64),
  unitKey: "cells",
};
const owner = "prn_nf-teacher-rivera";
const offer = "off_nf-eng9-fall-p3";

function pending(id = "cid_" + "a".repeat(32), key = "private-ai-test-001") {
  return CourseIntentDraftRecord.parse({
    id, offeringId: offer, ownerPrincipalId: owner, requestKey: key,
    source, goal: "low-equipment", status: "pending", revision: 1,
    createdAt: "2026-11-15T17:00:00Z", updatedAt: "2026-11-15T17:00:00Z",
  });
}
const intent = {
  profile: "educateos.pedagogical-intent/0.1",
  id: "ai-course-suggestion", revision: "0.1.0", source,
  origin: "machine-suggestion",
  learningGoals: [{ id: "cell-organs", statement: "Explain cell structures.", alignments: [] }],
  prerequisites: [], misconceptions: [],
  strategies: [{ id: "paper-cells", approach: "Create a diagram from paper.", conditions: [] }],
  expectedDemonstrations: [{
    id: "show-cell", goalId: "cell-organs", observable: "Label a cell diagram.", modality: "explain",
  }],
};
const report = {
  source, goal: "low-equipment", model: { provider: "cloudflare", modelId: "synthetic-model" },
  actualUsdNano: "10000", intent, draftOnly: true,
  warnings: ["Unapproved AI suggestion; local teacher review required."],
};
function proposed(base = pending()) {
  return CourseIntentDraftRecord.parse({
    ...base, status: "proposed", revision: 2, updatedAt: "2026-11-15T17:01:00Z", result: report,
  });
}
function reviewed(base = proposed()) {
  return CourseIntentDraftRecord.parse({
    ...base, status: "reviewed", revision: 3, updatedAt: "2026-11-15T17:02:00Z",
    reviewedBy: owner, selection: { goalIds: ["cell-organs"], strategyIds: ["paper-cells"] },
  });
}

describe("private curriculum drafts in real workerd SQLite", () => {
  it("persists append-only revisions across object restart and denies direct SQL mutations", async () => {
    const obj = fresh();
    const a = pending();
    const b = proposed(a);
    const c = reviewed(b);
    await runInDurableObject(obj, async (_instance, state) => {
      const store = new DurableObjectCourseIntentDraftStore(state.storage);
      expect((await store.claim(a)).created).toBe(true);
      expect((await store.claim({ ...a, id: "cid_" + "b".repeat(32) })).created).toBe(false);
      expect(await store.transition(b, 1)).toStrictEqual(b);
      expect(await store.transition(c, 2)).toStrictEqual(c);
      expect(await store.list(offer, owner)).toStrictEqual([c]);
      expect(await store.history(offer, owner, a.id)).toStrictEqual([a, b, c]);
      expect(await store.get(offer, "prn_other-teacher", a.id)).toBeUndefined();
      const t = DISTRICT_TABLES.courseIntentDraftRevisions;
      expect(() => state.storage.sql.exec(
        "UPDATE " + t + " SET record_json = '{}' WHERE draft_id = ?", a.id,
      )).toThrow(/immutable/);
      expect(() => state.storage.sql.exec("DELETE FROM " + t + " WHERE draft_id = ?", a.id))
        .toThrow(/immutable/);
    });
    await evictDurableObject(obj);
    await runInDurableObject(obj, async (_instance, state) => {
      const store = new DurableObjectCourseIntentDraftStore(state.storage);
      expect(await store.get(offer, owner, a.id)).toStrictEqual(c);
      expect(await store.history(offer, owner, a.id)).toStrictEqual([a, b, c]);
      await expect(store.transition(b, 1)).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("refuses cross-source idempotency and corrupted revision rows", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectCourseIntentDraftStore(state.storage);
      const a = pending();
      await store.claim(a);
      const changed = pending("cid_" + "b".repeat(32));
      await expect(store.claim({
        ...changed, source: { ...source, digest: "sha256:" + "b".repeat(64) },
      })).rejects.toMatchObject({ code: "conflict" });
      await store.transition(proposed(a), 1);
      await expect(store.transition(proposed(a), 1)).rejects.toMatchObject({ code: "conflict" });
      const table = DISTRICT_TABLES.courseIntentDraftRevisions;
      state.storage.sql.exec(
        "INSERT INTO " + table + " (draft_id, revision, record_json) VALUES (?, ?, ?)",
        a.id, 99, "{}",
      );
      await expect(store.get(offer, owner, a.id)).rejects.toThrow(/schema/);
    });
  });
});
