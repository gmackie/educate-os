// `DurableObjectWorkspaceStore` in workerd, against real Durable Object SQLite storage: a restarted
// object reads back the same directory, concurrent first accesses provision one workspace per key,
// and SQLite itself refuses a second workspace for a key.

import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WorkspaceId } from "@educateos/contracts";
import { DurableObjectWorkspaceStore, WORKSPACES_TABLE } from "../../src/durable-object-store.ts";
import type { PersonalWorkspace } from "../../src/index.ts";
import { O } from "../setup.ts";

let directories = 0;
const fresh = () => env.DIRECTORY.getByName(`directory-${directories++}`);

const AMARA = "prn_nf-student-amara";
const ELENA = "prn_nf-student-elena";

describe("DurableObjectWorkspaceStore", () => {
  it("reads a restarted object back to the same workspaces, and provisions nothing twice", async () => {
    const directory = fresh();
    const personal = await directory.personal(AMARA);
    const course = await directory.course(AMARA, O.bioFall);
    const before = await directory.stored();
    expect(before.state.workspaces.map((w) => w.id)).toEqual([personal, course]);
    expect(before.state.grants).toHaveLength(2);

    await evictDurableObject(directory);
    expect(await directory.stored()).toEqual(before);
    expect(await directory.personal(AMARA)).toBe(personal);
    expect(await directory.course(AMARA, O.bioFall)).toBe(course);
    expect((await directory.stored()).version).toBe(before.version);
  });

  it("provisions exactly one workspace per key under concurrent first accesses", async () => {
    const directory = fresh();
    const personals = await Promise.all(Array.from({ length: 8 }, () => directory.personal(AMARA)));
    const courses = await Promise.all(Array.from({ length: 8 }, () => directory.course(ELENA, O.bioFall)));
    expect(new Set(personals).size).toBe(1);
    expect(new Set(courses).size).toBe(1);
    const { state } = await directory.stored();
    expect(state.workspaces).toHaveLength(2);

    await evictDurableObject(directory);
    expect((await directory.stored()).state.workspaces).toHaveLength(2);
  });

  it("refuses a second workspace for a personal or course key, in SQLite as well as in code", async () => {
    const directory = fresh();
    const personal = await directory.personal(AMARA);
    await directory.course(AMARA, O.bioFall);
    await runInDurableObject(directory, async (_instance, state) => {
      const store = new DurableObjectWorkspaceStore(state.storage);
      const { version, state: current } = await store.load();
      const original = current.workspaces.find((w): w is PersonalWorkspace => w.id === personal)!;
      const second: PersonalWorkspace = { ...original, id: WorkspaceId.parse("wsp_second-personal") };
      await expect(store.commit({ ...current, workspaces: [...current.workspaces, second] }, version)).rejects.toMatchObject({ code: "policy-violation" });

      // Past the code's own check, straight into the table: the partial unique indexes refuse it.
      expect(() => state.storage.sql.exec(
        `INSERT INTO ${WORKSPACES_TABLE} (id, kind, owner_principal_id, offering_id, workspace_json) VALUES ('wsp_x', 'personal', ?, NULL, '{}')`,
        AMARA,
      )).toThrow(/UNIQUE/);
      expect(() => state.storage.sql.exec(
        `INSERT INTO ${WORKSPACES_TABLE} (id, kind, owner_principal_id, offering_id, workspace_json) VALUES ('wsp_y', 'course', ?, ?, '{}')`,
        AMARA,
        O.bioFall,
      )).toThrow(/UNIQUE/);
      expect((await store.load()).version).toBe(version);
    });
  });

  it("refuses a commit against a stale version, and keeps nothing of it", async () => {
    const directory = fresh();
    await directory.personal(AMARA);
    await runInDurableObject(directory, async (_instance, state) => {
      const store = new DurableObjectWorkspaceStore(state.storage);
      const { version, state: current } = await store.load();
      await store.commit({ ...current, closures: [] }, version);
      await expect(store.commit({ ...current, workspaces: [] }, version)).rejects.toMatchObject({ code: "conflict" });
      const reread = await new DurableObjectWorkspaceStore(state.storage).load();
      expect(reread.version).toBe(version + 1);
      expect(reread.state.workspaces).toHaveLength(1);
    });
  });
});
