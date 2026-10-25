// `DurableObjectSequenceCounter` in workerd, against real Durable Object SQLite storage: a
// restarted agent carries on above the root's last accepted sequence, concurrent requests never
// share a number, and the stored counter can't be moved backwards.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { NORTHFIELD } from "@educateos/fixtures";
import { describe, expect, it } from "vitest";
import { SEQUENCE_TABLE } from "../../src/durable-object-store.ts";
import { makeDistrict, makeRegistry, manualClock } from "../support.ts";

let agents = 0;
const fresh = () => env.AGENT.getByName(`agent-${agents++}`);

describe("DurableObjectSequenceCounter", () => {
  it("survives a restart, so the root keeps accepting the agent's heartbeats", async () => {
    const clock = manualClock();
    const { registry } = makeRegistry(clock);
    const district = await makeDistrict(NORTHFIELD, clock);
    await registry.register(await district.registration());
    const jwk = await district.identity.exportJwk();
    const counter = fresh();

    const heartbeat = async () => JSON.parse(await counter.heartbeat(jwk, district.instanceId, clock.now().toISOString())) as unknown;

    for (let i = 0; i < 3; i++) await registry.acceptHeartbeat(await heartbeat());
    await evictDurableObject(counter);
    // An in-memory counter would restart at 1 here and be refused as a replay.
    const afterRestart = await heartbeat();
    expect(afterRestart).toMatchObject({ payload: { sequence: 4 } });
    await expect(registry.acceptHeartbeat(afterRestart)).resolves.toBeUndefined();
  });

  it("gives 100 concurrent callers 100 distinct, contiguous numbers, and keeps them after a restart", async () => {
    const counter = fresh();
    const numbers = await Promise.all(Array.from({ length: 100 }, () => counter.next()));
    expect(numbers.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    await evictDurableObject(counter);
    expect(await counter.next()).toBe(101);
  });

  it("moves above a floor but never below what it handed out", async () => {
    const counter = fresh();
    await counter.ensureAbove(41);
    expect(await counter.next()).toBe(42);
    await counter.ensureAbove(10);
    expect(await counter.next()).toBe(43);
  });

  it("refuses a write that would move the stored counter backwards", async () => {
    const counter = fresh();
    await counter.next();
    await counter.next();
    await runInDurableObject(counter, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE ${SEQUENCE_TABLE} SET last = 0`)).toThrow(/never goes backwards/);
    });
    expect(await counter.next()).toBe(3);
  });
});
