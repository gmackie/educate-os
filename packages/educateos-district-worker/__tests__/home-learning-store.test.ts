// The home-learning store (ADR-0016) against real Durable Object SQLite: revisions and versions
// are checked in storage, an adult belongs to one family, indexes follow each commit, and a whole
// practice run through the service survives the object being evicted.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DistrictId, PrincipalId } from "@educateos/contracts";
import { DurableObjectHomeLearningStore } from "@educateos/district-app/durable-stores";
import { HomeLearningService, hashPin, type FamilyRecord, type Item } from "@educateos/home-learning";

let objects = 0;
const fresh = () => env.DISTRICT.getByName(`home-learning-${objects++}`);
const D = DistrictId.parse("dst_willowcreek");
const RIVERS = { principalId: PrincipalId.parse("prn_wc-parent-rivers"), districtId: D };

async function family(id: string, adult: string, revision = 1): Promise<FamilyRecord> {
  return {
    id: id as FamilyRecord["id"],
    districtId: D,
    name: "Family",
    adults: [{ principalId: PrincipalId.parse(adult), joinedAt: "2026-11-16T12:00:00.000Z" }],
    learners: [],
    queues: {},
    shelf: [],
    invitations: [],
    pin: await hashPin("2468", 10_000),
    createdAt: "2026-11-16T12:00:00.000Z",
    revision,
  };
}

const right = (item: Item) => {
  switch (item.type) {
    case "count-objects": return { kind: "number" as const, value: item.answer };
    default: throw new Error(`unexpected ${item.type}`);
  }
};

describe("DurableObjectHomeLearningStore", () => {
  it("commits a family only over the revision it read, and keeps an adult in one family", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const store = new DurableObjectHomeLearningStore(state.storage);
      const first = await family("fam_rivers", "prn_wc-parent-rivers");
      await store.commitFamily(first, undefined);
      await expect(store.commitFamily(first, undefined)).rejects.toMatchObject({ code: "conflict" });
      await expect(store.commitFamily({ ...first, revision: 3 }, 1)).rejects.toMatchObject({ code: "conflict" });
      await store.commitFamily({ ...first, name: "Rivers", revision: 2 }, 1);
      expect((await store.loadFamily(first.id))?.name).toBe("Rivers");
      expect(await store.familyOfAdult(PrincipalId.parse("prn_wc-parent-rivers"))).toBe("fam_rivers");
      await expect(store.commitFamily(await family("fam_other", "prn_wc-parent-rivers"), undefined)).rejects.toMatchObject({ code: "conflict" });
      expect(await store.loadFamily("fam_other" as FamilyRecord["id"])).toBeUndefined();
    });
  });

  it("runs a whole practice through the service and keeps it across a restart", async () => {
    const object = fresh();
    const allow = { authorize: async () => ({ effect: "allow" as const }) };
    let learnerId = "";
    let sessionId = "";
    let token = "";
    await runInDurableObject(object, async (_instance, state) => {
      const service = new HomeLearningService({ store: new DurableObjectHomeLearningStore(state.storage), authorizer: allow, districtId: D });
      await service.createFamily(RIVERS, { name: "Rivers", pin: "2468" });
      const maya = await service.addLearner(RIVERS, { displayName: "Maya", avatar: "🦊", gradeBand: "K" });
      learnerId = maya.id;
      await service.addToQueue(RIVERS, maya.id, { pack: "number-sense", activity: "count-to-5" });
      ({ token } = await service.startChildSession(RIVERS, maya.id));
      const child = (await service.childSession(RIVERS, token))!;
      const entry = (await service.practiceHome(RIVERS, child)).queue[0]!;
      const view = await service.startPractice(RIVERS, child, entry.entryId);
      sessionId = view.sessionId;
      // Two of five saved: the session stays open to resume.
      for (const item of view.items.slice(0, 2)) {
        await service.saveResponse(RIVERS, child, view.sessionId, { requestId: crypto.randomUUID(), item: item.key, answers: [right(item)], hintUsed: false, adultHelped: false });
      }
    });
    await evictDurableObject(object);
    await runInDurableObject(object, async (_instance, state) => {
      const service = new HomeLearningService({ store: new DurableObjectHomeLearningStore(state.storage), authorizer: allow, districtId: D });
      const child = (await service.childSession(RIVERS, token))!;
      expect(child.learnerId).toBe(learnerId);
      const entry = (await service.practiceHome(RIVERS, child)).queue[0]!;
      expect(entry.inProgress).toBe(true);
      const resumed = await service.startPractice(RIVERS, child, entry.entryId);
      expect(resumed.sessionId).toBe(sessionId);
      expect(resumed.saved).toHaveLength(2);
      for (const item of resumed.items.filter((i) => !resumed.saved.includes(i.key))) {
        await service.saveResponse(RIVERS, child, resumed.sessionId, { requestId: crypto.randomUUID(), item: item.key, answers: [right(item)], hintUsed: false, adultHelped: false });
      }
      expect((await service.practiceHome(RIVERS, child)).queue).toEqual([]);
      const progress = await service.progress(RIVERS, learnerId);
      expect(progress.sessions).toHaveLength(1);
      expect(progress.skills.find((s) => s.skillId === "count.within-10")?.responses).toBe(5);
      await service.endChildSession(RIVERS, child, "2468");
      expect(await service.childSession(RIVERS, token)).toBeUndefined();
      await service.removeLearner(RIVERS, learnerId);
      expect((await service.exportFamily(RIVERS)).sessions).toEqual([]);
    });
  });
});
