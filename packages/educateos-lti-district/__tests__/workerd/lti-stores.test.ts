// The district LTI stores over `DurableObjectRecordTable`, in workerd, against real Durable Object
// SQLite storage (SCHO-60): a login state is taken once however many requests race for it, a
// passback version is claimed once, deep-linked activity links never overwrite one another, the
// tool's signing keys and their rotation are kept (SCHO-177), and everything survives a restart of
// the object.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LTI_COLLECTIONS, LtiStoredRecordError, TableSingleUseStore } from "../../src/stores.ts";
import { DurableObjectRecordTable, LTI_RECORDS_TABLE } from "../../src/durable-object.ts";
import { LoginState } from "@educateos/lti";

let objects = 0;
const fresh = () => env.LTI.getByName(`district-${objects++}`);

describe("district LTI stores in a Durable Object", () => {
  it("hands a login state to exactly one of 50 concurrent launches, and never again", async () => {
    const district = fresh();
    await district.putLoginState("state-1", 60_000);
    const taken = await Promise.all(Array.from({ length: 50 }, () => district.takeLoginState("state-1")));
    expect(taken.filter((value) => value !== undefined)).toHaveLength(1);
    await evictDurableObject(district);
    expect(await district.takeLoginState("state-1")).toBeUndefined();
  });

  it("keeps an untaken login state across a restart, and refuses it once expired", async () => {
    const district = fresh();
    await district.putLoginState("kept", 60_000);
    await district.putLoginState("expired", -1);
    await evictDurableObject(district);
    expect(await district.takeLoginState("kept")).toMatchObject({ nonce: "nonce-kept" });
    expect(await district.takeLoginState("expired")).toBeUndefined();
  });

  it("claims a passback version for exactly one of 50 concurrent requests, and remembers it was posted", async () => {
    const district = fresh();
    const claims = await Promise.all(Array.from({ length: 50 }, () => district.claim("col|amara", 1, 1_000)));
    expect(claims.filter((claim) => claim === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim === "in-progress")).toHaveLength(49);
    await district.complete("col|amara", 1);
    await evictDurableObject(district);
    expect(await district.claim("col|amara", 1, 1_000)).toBe("already-posted");
    expect(await district.claim("col|amara", 0, 500)).toBe("stale");
  });

  it("adds concurrent deep-linked activity links without losing any, and refuses a duplicate", async () => {
    const district = fresh();
    await district.saveRegistration();
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => district.addActivityLink(`dl-${i}`)),
      ...Array.from({ length: 5 }, () => district.addActivityLink("dl-same")),
    ]);
    expect(results.filter((result) => result === "added")).toHaveLength(21);
    expect(results.filter((result) => result === "conflict")).toHaveLength(4);
    await evictDurableObject(district);
    expect((await district.registration())?.activityLinks).toHaveLength(21);
  });

  it("keeps the tool's signing key, and a rotation, across restarts", async () => {
    const district = fresh();
    const [first] = await district.toolKeyIds();
    await evictDurableObject(district);
    expect(await district.toolKeyIds()).toEqual([first]);

    const rotation = await district.rotateToolKeys();
    expect(rotation.retiredKids).toEqual([first]);
    await evictDurableObject(district);
    expect(await district.toolKeyIds()).toEqual([rotation.signingKid, first]);
  });

  it("refuses to read a tampered row", async () => {
    const district = fresh();
    await runInDurableObject(district, async (_instance, state) => {
      const table = new DurableObjectRecordTable(state.storage);
      state.storage.sql.exec(
        `INSERT INTO ${LTI_RECORDS_TABLE} (collection, key, value_json, expires_at) VALUES (?, ?, ?, ?)`,
        LTI_COLLECTIONS.loginStates,
        "tampered",
        JSON.stringify({ issuer: "http://insecure.example" }),
        Date.now() + 60_000,
      );
      await expect(new TableSingleUseStore(table, LTI_COLLECTIONS.loginStates, LoginState).take("tampered")).rejects.toBeInstanceOf(LtiStoredRecordError);
    });
  });
});
