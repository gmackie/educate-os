import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { PrincipalId } from "@educateos/contracts";
import { durableStudentLearningLifecycle, DurableObjectGuidanceStore, DurableObjectPlannerStore } from "@educateos/district-app/durable-stores";

it("persists subject deletion and the write fence across a real Durable Object eviction", async () => {
  const object = env.DISTRICT.getByName("student-learning-lifecycle");
  const studentId = PrincipalId.parse("prn_lifecycle-student");
  const actor = PrincipalId.parse("prn_lifecycle-admin");
  const at = "2026-11-15T12:00:00.000Z";
  const pref = { type: "preference" as const, id: "preference", scope: `student:${studentId}`, studentId, revision: 1, guardianSuggestions: "on" as const, updatedAt: at };
  let receiptId: string;
  await runInDurableObject(object, async (_instance, state) => {
    const lifecycle = durableStudentLearningLifecycle(state.storage);
    const records = new DurableObjectGuidanceStore(state.storage);
    await records.save(pref, 0);
    // Legacy plan JSON: inventory and deletion must not depend on current roster or plan schema.
    state.storage.sql.exec("INSERT INTO educateos_planner VALUES (?, ?, ?, ?)", "legacy-plan", "off_removed", 1, JSON.stringify({ studentId, goal: "private legacy text" }));
    lifecycle.configure(studentId, { legalHold: true, deletionAuthorized: true, archiveSatisfied: true }, 0);
    expect(() => lifecycle.purge(studentId, actor, at, 1)).toThrow(/blocked/);
    lifecycle.configure(studentId, { legalHold: false, deletionAuthorized: true, archiveSatisfied: true }, 1);
    const receipt = lifecycle.purge(studentId, actor, at, 2);
    receiptId = receipt.id;
    expect(receipt.counts).toEqual({ plans: 1, guidance: 1, guardianGrants: 0, aiRuntimeCounters: 0 });
  });
  await evictDurableObject(object);
  await runInDurableObject(object, async (_instance, state) => {
    const lifecycle = durableStudentLearningLifecycle(state.storage);
    expect(lifecycle.purge(studentId, actor, at, 2).id).toBe(receiptId);
    expect(lifecycle.preview(studentId, at).counts).toEqual({ plans: 0, guidance: 0, guardianGrants: 0, aiRuntimeCounters: 0 });
    await expect(new DurableObjectGuidanceStore(state.storage).save(pref, 0)).rejects.toMatchObject({ code: "conflict" });
    expect(await new DurableObjectPlannerStore(state.storage).list("off_removed")).toEqual([]);
    expect(() => lifecycle.configure(studentId, { legalHold: false, deletionAuthorized: true, archiveSatisfied: true }, 3)).toThrow(/changed/);
  });
});
