// `DurableObjectContentStudioStorage` in workerd, against real Durable Object SQLite storage: a
// restarted studio object reads back the same items, releases, snapshots and audit; item writes are
// compare-and-set; releases, bindings, snapshots and audit cannot be rewritten; and rows that fail
// their schema are never trusted.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DurableObjectContentStudioStorage, SNAPSHOT_CHUNK_BYTES, STUDIO_TABLES, StudioStorageCorruptionError } from "../../src/durable-object-store.ts";
import type { Result } from "./worker.ts";

const MORGAN = "prn_nf-morgan-lee";
const RIVERA = "prn_nf-teacher-rivera";

let studios = 0;
const fresh = () => env.STUDIO.getByName(`dst_northfield-${studios++}`);

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
};

describe("DurableObjectContentStudioStorage", () => {
  it("reads back the same items, releases, snapshots and audit after the object restarts", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells are the unit of life."));
    const release = value(await studio.approve(MORGAN, item.id));
    value(await studio.bind(MORGAN, item.resourceId));
    const items = await studio.items();
    const audit = await studio.audit(item.id);

    await evictDurableObject(studio);
    expect(await studio.items()).toStrictEqual(items);
    // Stored as JSON, so an absent optional field comes back absent rather than `undefined`.
    expect(await studio.releases()).toStrictEqual(JSON.parse(JSON.stringify([release])));
    expect(await studio.audit(item.id)).toStrictEqual(audit);
    expect(audit.map((event) => event.type)).toContain("bound");
    expect(new TextDecoder().decode(await studio.snapshot(item.snapshotDigest))).toBe("Cells are the unit of life.");
    // ...and still knows the item is decided.
    expect(await studio.approve(MORGAN, item.id)).toStrictEqual({ ok: false, code: "conflict" });
  });

  it("releases an item once when two approvals race", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells."));
    const results = await Promise.all([studio.approve(MORGAN, item.id), studio.approve(MORGAN, item.id)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toStrictEqual([{ ok: false, code: "conflict" }]);
    await evictDurableObject(studio);
    expect(await studio.releases()).toHaveLength(1);
  });

  it("refuses an item write based on a stale read, and a second release of one version", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells."));
    const release = value(await studio.approve(MORGAN, item.id));
    await runInDurableObject(studio, async (_, state) => {
      const first = new DurableObjectContentStudioStorage(state.storage);
      const second = new DurableObjectContentStudioStorage(state.storage);
      const a = (await first.getItem(item.id))!;
      const b = (await second.getItem(item.id))!;
      await first.putItem({ ...a, revision: a.revision + 1, title: "first" });
      await expect(second.putItem({ ...b, revision: b.revision + 1, title: "second" })).rejects.toMatchObject({ code: "conflict" });
      expect((await second.getItem(item.id))?.title).toBe("first");
      await expect(first.addRelease(release)).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("keeps releases, bindings, snapshots and audit append-only at the storage layer", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells."));
    value(await studio.approve(MORGAN, item.id));
    value(await studio.bind(MORGAN, item.resourceId));
    await runInDurableObject(studio, (_, state) => {
      for (const table of [STUDIO_TABLES.releases, STUDIO_TABLES.bindings, STUDIO_TABLES.snapshotChunks, STUDIO_TABLES.audit]) {
        expect(() => state.storage.sql.exec(`UPDATE ${table} SET rowid = rowid`)).toThrow(/append-only/);
        expect(() => state.storage.sql.exec(`DELETE FROM ${table}`)).toThrow(/append-only/);
      }
    });
    expect(await studio.releases()).toHaveLength(1);
  });

  it("stores snapshots larger than one SQLite value, and a digest once", async () => {
    const studio = fresh();
    await runInDurableObject(studio, async (_, state) => {
      const storage = new DurableObjectContentStudioStorage(state.storage);
      const big = new Uint8Array(SNAPSHOT_CHUNK_BYTES * 2 + 17);
      for (let i = 0; i < big.length; i++) big[i] = i % 251;
      await storage.putSnapshot("sha256:big", big);
      await storage.putSnapshot("sha256:big", new Uint8Array([1, 2, 3]));
      const read = (await storage.getSnapshot("sha256:big"))!;
      expect(read.byteLength).toBe(big.byteLength);
      expect(read.every((byte, i) => byte === big[i])).toBe(true);
      expect(await storage.getSnapshot("sha256:absent")).toBeUndefined();
    });
  });

  it("refuses rows that fail their schema rather than returning them", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells."));
    await runInDurableObject(studio, async (_, state) => {
      const storage = new DurableObjectContentStudioStorage(state.storage);
      // A release inserted behind the store's back, with a descriptor the registry would refuse.
      state.storage.sql.exec(
        `INSERT INTO ${STUDIO_TABLES.releases} (row_schema_version, resource_id, version, release_json) VALUES (1, ?, '9.0.0', ?)`,
        item.resourceId,
        JSON.stringify({ descriptor: { id: item.resourceId, kind: "malware" }, itemId: item.id }),
      );
      await expect(storage.listReleases()).rejects.toThrow(StudioStorageCorruptionError);
      state.storage.sql.exec(`INSERT INTO ${STUDIO_TABLES.audit} (row_schema_version, item_id, event_json) VALUES (7, ?, '{}')`, item.id);
      await expect(storage.listAudit(item.id)).rejects.toThrow(/unknown schema version 7/);
      state.storage.sql.exec(`UPDATE ${STUDIO_TABLES.items} SET revision = revision + 5 WHERE id = ?`, item.id);
      await expect(storage.getItem(item.id)).rejects.toThrow(StudioStorageCorruptionError);
    });
  });

  it("authorizes as the studio does: a teacher cannot approve another class's item", async () => {
    const studio = fresh();
    const item = value(await studio.upload(MORGAN, "cells.txt", "Cells."));
    expect(await studio.approve(RIVERA, item.id)).toStrictEqual({ ok: false, code: "not-found" });
  });
});
