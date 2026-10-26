// The district's durable tool keys over the in-memory record table (SCHO-177): the first key is
// generated once however many first reads race, a rotation signs with a new key while the previous
// one stays published, and a tampered record is refused. The Durable Object table's restart
// behaviour is in `workerd/`.
import { describe, expect, it } from "vitest";
import { toolJwks } from "@educateos/lti";
import { InMemoryRecordTable, LtiStoredRecordError, TableToolKeyStore, TOOL_KEYS_COLLECTION, TOOL_KEYS_RECORD } from "../src/index.ts";

const kids = (set: Awaited<ReturnType<TableToolKeyStore["keySet"]>>) => toolJwks(set).keys.map((key) => key.kid);

describe("TableToolKeyStore", () => {
  it("generates one signing key, which every racing first read and every later store agrees on", async () => {
    const table = new InMemoryRecordTable();
    const sets = await Promise.all(Array.from({ length: 5 }, () => new TableToolKeyStore(table).keySet()));
    const signing = new Set(sets.map((set) => set.signing.kid));
    expect(signing.size).toBe(1);
    expect((await new TableToolKeyStore(table).keySet()).signing.kid).toBe([...signing][0]);
  });

  it("rotates to a new signing key, keeps the previous one published, and drops older ones", async () => {
    const table = new InMemoryRecordTable();
    const store = new TableToolKeyStore(table, () => Date.parse("2026-10-26T00:00:00Z"));
    const first = (await store.keySet()).signing.kid;

    const rotation = await store.rotate();
    expect(rotation).toEqual({ signingKid: expect.any(String), retiredKids: [first], since: "2026-10-26T00:00:00.000Z" });
    const second = await store.keySet();
    expect(second.signing.kid).toBe(rotation.signingKid);
    expect(kids(second)).toEqual([rotation.signingKid, first]);

    const third = await store.rotate();
    expect(kids(await new TableToolKeyStore(table).keySet())).toEqual([third.signingKid, rotation.signingKid]);
  });

  it("publishes only public halves", async () => {
    const jwks = toolJwks(await new TableToolKeyStore(new InMemoryRecordTable()).keySet());
    expect(Object.keys(jwks.keys[0]!).toSorted()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("refuses a stored key set that does not match its schema", async () => {
    const table = new InMemoryRecordTable();
    table.put(TOOL_KEYS_COLLECTION, TOOL_KEYS_RECORD, { signing: { kid: "x" }, retired: [] });
    await expect(new TableToolKeyStore(table).keySet()).rejects.toBeInstanceOf(LtiStoredRecordError);
    await expect(new TableToolKeyStore(table).rotate()).rejects.toBeInstanceOf(LtiStoredRecordError);
  });
});
