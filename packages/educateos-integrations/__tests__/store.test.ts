import { DistrictDirectorySnapshot, EducateOsError, type IntegrationSyncRun } from "@educateos/contracts";
import { NORTHFIELD } from "@educateos/fixtures";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { oneroster } from "../src/index.ts";
import { loadExport } from "./fixtures/load.ts";

const CONFIG: oneroster.OneRosterImportConfig = { issuer: "https://idp.northfield.example", subject: { field: "username" } };

const initial = (): oneroster.RosterSyncState => ({
  roster: {
    snapshot: DistrictDirectorySnapshot.parse({
      district: NORTHFIELD.district,
      schools: [],
      terms: [],
      courses: [],
      offerings: [],
      principals: [],
      enrollments: [],
      roleAssignments: [],
    }),
    sources: oneroster.EMPTY_SOURCE_MAP,
  },
});

/** A Durable Object's SQL storage, played by Node's SQLite. */
function sqliteStorage(): oneroster.RosterSqlStorage & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    sql: {
      // Like the Durable Object API, a statement runs when it is executed, not when it is read.
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (closure) => {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const STORES: [string, () => oneroster.RosterSyncStore][] = [
  ["in memory", () => new oneroster.InMemoryRosterSyncStore()],
  ["in a Durable Object", () => new oneroster.DurableObjectRosterSyncStore(sqliteStorage())],
];

let runs = 0;
function syncWith(store: oneroster.RosterSyncStore, afterApply?: (result: oneroster.RosterSyncResult) => Promise<void>) {
  runs += 1;
  return oneroster.runStoredRosterSync({
    store,
    initial,
    source: oneroster.csvRosterSource(loadExport("northfield")),
    mode: "complete",
    config: CONFIG,
    runId: `run-${runs}`,
    clock: () => new Date("2026-10-20T15:00:00Z"),
    ...(afterApply === undefined ? {} : { afterApply }),
  });
}

describe.each(STORES)("a roster sync store %s", (_name, storeOf) => {
  it("keeps the state a sync leaves and its run history, and the next sync starts from it", async () => {
    const store = storeOf();
    expect(await store.load()).toBeUndefined();
    const first = await syncWith(store);
    expect(first.version).toBe(1);
    expect((await store.load())?.state).toEqual(first.state);

    const second = await syncWith(store);
    expect(second.run.counts.principals).toEqual({ added: 0, updated: 0, deactivated: 0 });
    expect(second.version).toBe(2);
    expect((await store.runs()).map((r) => r.id)).toEqual([first.run.id, second.run.id]);
    expect((await store.runs(1)).map((r) => r.id)).toEqual([second.run.id]);
  });

  it("refuses the second of two syncs started from the same state, keeping nothing of it", async () => {
    const store = storeOf();
    const loaded = await store.load();
    const result = await oneroster.runRosterSync({
      state: initial(),
      source: oneroster.csvRosterSource(loadExport("northfield")),
      mode: "complete",
      config: CONFIG,
      runId: "racer",
      clock: () => new Date("2026-10-20T15:00:00Z"),
    });
    await store.commit(result.run, result.state, loaded?.version);
    await expect(store.commit({ ...result.run, id: "loser" }, result.state, loaded?.version)).rejects.toMatchObject({ code: "conflict" });
    expect((await store.runs()).map((r) => r.id)).toEqual(["racer"]);
  });

  it("records a failed run without touching the state, and runs afterApply only for an applied sync", async () => {
    const store = storeOf();
    const applied: string[] = [];
    const ok = await syncWith(store, async (result) => {
      applied.push(result.run.id);
    });
    const failed = await oneroster.runStoredRosterSync({
      store,
      initial,
      source: oneroster.csvRosterSource({}),
      mode: "complete",
      config: CONFIG,
      runId: "broken-export",
      clock: () => new Date("2026-10-20T16:00:00Z"),
      afterApply: async (result) => {
        applied.push(result.run.id);
      },
    });
    expect(failed.run.outcome).toBe("failed");
    expect(applied).toEqual([ok.run.id]);
    expect((await store.load())?.version).toBe(1);
    expect((await store.runs()).map((r) => r.outcome)).toEqual(["succeeded", "failed"]);
  });
});

describe("the Durable Object store", () => {
  it("stores a state larger than one SQLite value in chunks and reads it back whole", async () => {
    const storage = sqliteStorage();
    const store = new oneroster.DurableObjectRosterSyncStore(storage);
    const users = Array.from({ length: 6000 }, (_, i) => ({
      sourcedId: `u-${i}`,
      status: "active" as const,
      enabledUser: true,
      userIds: [],
      givenName: "Synthetic",
      familyName: `Student ${i}`,
      grades: ["09"],
    }));
    const mirror = Object.fromEntries(oneroster.ONEROSTER_FILES.map((file) => [file, []])) as unknown as oneroster.RosterMirror;
    const state = { ...initial(), mirror: { ...mirror, "users.csv": users } };
    const run: IntegrationSyncRun = {
      id: "big",
      mode: "complete",
      startedAt: "2026-10-20T15:00:00.000Z",
      finishedAt: "2026-10-20T15:00:01.000Z",
      counts: (await syncWith(new oneroster.InMemoryRosterSyncStore())).run.counts,
      outcome: "succeeded",
    };
    await store.commit(run, state, undefined);
    const chunks = storage.db.prepare(`SELECT COUNT(*) AS n FROM ${oneroster.ROSTER_SYNC_TABLES.chunks}`).get() as { n: number };
    expect(chunks.n).toBeGreaterThan(1);
    expect((await new oneroster.DurableObjectRosterSyncStore(storage).load())?.state).toEqual(state);
  });

  it("refuses to load a state that was altered in storage, without quoting it", async () => {
    const storage = sqliteStorage();
    const store = new oneroster.DurableObjectRosterSyncStore(storage);
    await syncWith(store);
    storage.db.prepare(`UPDATE ${oneroster.ROSTER_SYNC_TABLES.chunks} SET data = substr(data, 2) WHERE part = 0`).run();
    const error = await new oneroster.DurableObjectRosterSyncStore(storage).load().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(oneroster.RosterStoreCorruptionError);
    expect(error).not.toBeInstanceOf(EducateOsError);
    expect(String(error)).not.toContain("northfield.example");
  });
});

const run = (mode: "complete" | "delta", finishedAt: string, outcome: "succeeded" | "failed" = "succeeded"): IntegrationSyncRun => ({
  id: `${mode}-${finishedAt}`,
  mode,
  startedAt: finishedAt,
  finishedAt,
  counts: {
    schools: { added: 0, updated: 0, deactivated: 0 },
    terms: { added: 0, updated: 0, deactivated: 0 },
    courses: { added: 0, updated: 0, deactivated: 0 },
    offerings: { added: 0, updated: 0, deactivated: 0 },
    principals: { added: 0, updated: 0, deactivated: 0 },
    enrollments: { added: 0, updated: 0, deactivated: 0 },
    roleAssignments: { added: 0, removed: 0 },
  },
  outcome,
  ...(outcome === "failed" ? { errorCode: "source-unavailable" as const } : {}),
});
const at = (iso: string) => new Date(iso);

describe("dueRosterSync", () => {
  const schedule = { deltaEveryMinutes: 15, completeEveryHours: 24 };
  it("starts with a complete sync, then deltas, then a complete sync again once a day", () => {
    expect(oneroster.dueRosterSync(schedule, [], ["complete", "delta"], at("2026-10-20T08:00:00Z"))).toBe("complete");
    const history = [run("complete", "2026-10-20T08:00:00Z")];
    expect(oneroster.dueRosterSync(schedule, history, ["complete", "delta"], at("2026-10-20T08:10:00Z"))).toBeUndefined();
    expect(oneroster.dueRosterSync(schedule, history, ["complete", "delta"], at("2026-10-20T08:15:00Z"))).toBe("delta");
    expect(oneroster.dueRosterSync(schedule, history, ["complete"], at("2026-10-20T08:15:00Z"))).toBeUndefined();
    expect(oneroster.dueRosterSync(schedule, history, ["complete", "delta"], at("2026-10-21T08:00:00Z"))).toBe("complete");
  });

  it("retries a failing complete sync at the delta interval, not continuously", () => {
    const history = [run("complete", "2026-10-20T08:00:00Z", "failed")];
    expect(oneroster.dueRosterSync(schedule, history, ["complete", "delta"], at("2026-10-20T08:05:00Z"))).toBeUndefined();
    expect(oneroster.dueRosterSync(schedule, history, ["complete", "delta"], at("2026-10-20T08:15:00Z"))).toBe("complete");
  });
});
