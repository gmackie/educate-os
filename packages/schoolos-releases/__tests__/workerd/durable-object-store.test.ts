// The releases Durable Object stores in workerd, against real Durable Object SQLite storage: the
// district's decisions and replay protection survive a restart, concurrent offers lose no update,
// an unreadable state is refused, and offer sequences are atomic per instance.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { StoredRowCorruptionError } from "@schoolos/fleet/durable-object-store";
import { describe, expect, it } from "vitest";
import { DistrictReleaseState } from "../../src/index.ts";
import { DISTRICT_RELEASE_STATE_TABLE, DurableObjectDistrictReleaseStore, ROLLOUT_TABLES } from "../../src/durable-object-store.ts";
import { baseline, makeSigner, manualClock, signedOffer, statementFor } from "../support.ts";

let objects = 0;
const name = () => `object-${objects++}`;

// The error an RPC call rejected with. Settling the stub's promise this way, rather than through
// `expect(...).rejects`, keeps workerd from also reporting the rejection as unhandled.
async function rpcFailure(call: Promise<unknown>): Promise<unknown> {
  const [outcome] = await Promise.allSettled([call]);
  if (outcome?.status !== "rejected") throw new Error("expected the call to fail");
  return outcome.reason;
}

async function pinnedDistrict() {
  // The objects run on the real clock, so the offers are made on it too.
  const clock = manualClock(new Date().toISOString());
  const { signer, trust } = await makeSigner();
  const district = env.DISTRICT.getByName(name());
  const pin = () => district.pin(JSON.stringify(trust), JSON.stringify(baseline(clock)));
  await pin();
  return { clock, signer, district, pin };
}

describe("DurableObjectDistrictReleaseStore", () => {
  it("keeps decisions, declines and the last offer sequence across a restart", async () => {
    const { clock, signer, district, pin } = await pinnedDistrict();
    const offer = JSON.stringify(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0")));
    expect(await district.receiveOffer(offer)).toBe("pending");
    await district.decline(1, "testing-window");
    const before = DistrictReleaseState.parse(JSON.parse(await district.state()));

    await evictDurableObject(district);
    await pin();
    expect(DistrictReleaseState.parse(JSON.parse(await district.state()))).toEqual(before);
    // The replay protection was stored, not just cached: the same offer is refused after the restart.
    expect(await rpcFailure(district.receiveOffer(offer))).toMatchObject({ message: "replayed or out-of-order release offer" });
    // ...and the decline still covers the release when the root offers it again.
    const again = JSON.stringify(await signedOffer(signer, clock, statementFor(clock, "r2-fixture", "0.2.0"), { offerSequence: 2 }));
    expect(await district.receiveOffer(again)).toBe("declined");
  });

  it("loses no update when offers arrive concurrently", async () => {
    const { clock, signer, district } = await pinnedDistrict();
    const offers = await Promise.all(Array.from({ length: 10 }, async (_, i) =>
      JSON.stringify(await signedOffer(signer, clock, statementFor(clock, `r2-fixture-${i}`, "0.2.0"), { offerSequence: i + 1 }))));
    const results = await Promise.allSettled(offers.map((offer) => district.receiveOffer(offer)));
    const accepted = results.filter((result) => result.status === "fulfilled").length;

    const state = DistrictReleaseState.parse(JSON.parse(await district.state()));
    // Every offer that was accepted is on record, and the highest sequence among them is the one held.
    expect(state.offers).toHaveLength(accepted);
    expect(state.lastOfferSequence).toBe(Math.max(...state.offers.map((offer) => offer.offerSequence)));
    expect(state.offers.filter((offer) => offer.status === "pending")).toHaveLength(1);
  });

  it("refuses a stored state it can't read instead of starting again from the pinned keys", async () => {
    const { district } = await pinnedDistrict();
    await district.state();
    await runInDurableObject(district, async (_instance, state) => {
      const store = new DurableObjectDistrictReleaseStore(state.storage);
      await store.load();
      state.storage.sql.exec(`INSERT INTO ${DISTRICT_RELEASE_STATE_TABLE} (id, state_json) VALUES (1, '{"trust":{}}')`);
      await expect(store.load()).rejects.toThrow(StoredRowCorruptionError);
      state.storage.sql.exec(`UPDATE ${DISTRICT_RELEASE_STATE_TABLE} SET state_json = 'not json'`);
      await expect(store.load()).rejects.toThrow(StoredRowCorruptionError);
    });
  });
});

describe("DurableObjectRolloutStore", () => {
  it("hands 100 concurrent offers to one instance 100 distinct sequences, per instance, across a restart", async () => {
    const rollout = env.ROLLOUT.getByName(name());
    const sequences = await Promise.all(Array.from({ length: 100 }, () => rollout.nextOfferSequence("ins_northfield")));
    expect(sequences.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(await rollout.nextOfferSequence("ins_riverbend")).toBe(1);

    await evictDurableObject(rollout);
    expect(await rollout.nextOfferSequence("ins_northfield")).toBe(101);
    await runInDurableObject(rollout, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${ROLLOUT_TABLES.offerSequences}`).one().n).toBe(2);
    });
  });

  it("keeps channel state across a restart and refuses one that doesn't parse", async () => {
    const clock = manualClock();
    const { signer } = await makeSigner();
    const rollout = env.ROLLOUT.getByName(name());
    expect(JSON.parse(await rollout.channel("stable"))).toEqual({ releases: {} });
    const state = { releases: { "r2-fixture": await signer.signManifest(statementFor(clock, "r2-fixture", "0.2.0")) } };
    await rollout.saveChannel("stable", JSON.stringify(state));
    await evictDurableObject(rollout);
    expect(JSON.parse(await rollout.channel("stable"))).toEqual(state);
    expect(JSON.parse(await rollout.channel("canary"))).toEqual({ releases: {} });
    expect(await rpcFailure(rollout.saveChannel("stable", JSON.stringify({ releases: {}, extra: true })))).toBeInstanceOf(Error);
  });
});
