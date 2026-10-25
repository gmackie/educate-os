// Where a roster integration keeps its state between syncs, and its run history: the storage
// interface, an in-memory store, a Durable Object (SQLite) store, the sync loop over a store, and
// the schedule that says when the next sync is due. New for EducateOS.
//
// The stored state holds roster PII: the directory snapshot and the mirror carry names, usernames,
// emails and IdP subjects. It never leaves the store except as the next sync's input, and the run
// history holds counts and error codes only.
import { DistrictDirectorySnapshot, IntegrationSyncRun, RosterSyncSchedule, EducateOsError, type SyncMode } from "@educateos/contracts";
import { z } from "zod";
import { OneRosterSourceMap } from "./source-map.ts";
import { RosterCursors, RosterMirror, runRosterSync } from "./sync.ts";
import type { RosterSyncInput, RosterSyncResult, RosterSyncState } from "./sync.ts";

/** The stored form of a {@link RosterSyncState}, validated whenever it is read back. */
export const StoredRosterSyncState = z.strictObject({
  roster: z.strictObject({ snapshot: DistrictDirectorySnapshot, sources: OneRosterSourceMap }),
  mirror: RosterMirror.optional(),
  cursors: RosterCursors.optional(),
});

/** A stored state and the version a commit over it must name. */
export interface StoredRosterSync {
  /** Counts commits of a state, from 1. */
  version: number;
  /** The state the last successful sync left. */
  state: RosterSyncState;
}

/** How many runs a store keeps. Older ones are dropped as new ones are recorded. */
export const MAX_STORED_RUNS = 1000;

/** Where a roster integration keeps its state and its run history. */
export interface RosterSyncStore {
  /** The stored state and its version, or `undefined` before the first successful sync. */
  load(): Promise<StoredRosterSync | undefined>;
  /**
   * Records `run` and, when `next` is given, replaces the state, in one step. A state replaces only
   * the version it was computed from (`expectedVersion`, `undefined` for none), so of two syncs
   * started together only the first commits; the second is refused with `conflict` and nothing it
   * did is kept. A run with no state (one that failed) is always recorded.
   *
   * @returns The state's version after the commit.
   */
  commit(run: IntegrationSyncRun, next: RosterSyncState | undefined, expectedVersion: number | undefined): Promise<number | undefined>;
  /** The most recent runs, at most `limit` of them, oldest first. */
  runs(limit?: number): Promise<IntegrationSyncRun[]>;
}

function staleCommit(): EducateOsError {
  return new EducateOsError("conflict", "another roster sync committed first; run this one again");
}

/** A {@link RosterSyncStore} in memory, for tests and the local harness. */
export class InMemoryRosterSyncStore implements RosterSyncStore {
  #stored: StoredRosterSync | undefined;
  #runs: IntegrationSyncRun[] = [];

  async load(): Promise<StoredRosterSync | undefined> {
    return this.#stored === undefined ? undefined : structuredClone(this.#stored);
  }

  async commit(run: IntegrationSyncRun, next: RosterSyncState | undefined, expectedVersion: number | undefined): Promise<number | undefined> {
    const parsedRun = IntegrationSyncRun.parse(run);
    if (next !== undefined) {
      if (this.#stored?.version !== expectedVersion) throw staleCommit();
      this.#stored = { version: (expectedVersion ?? 0) + 1, state: structuredClone(StoredRosterSyncState.parse(next)) };
    }
    this.#runs = [...this.#runs, parsedRun].slice(-MAX_STORED_RUNS);
    return this.#stored?.version;
  }

  async runs(limit = MAX_STORED_RUNS): Promise<IntegrationSyncRun[]> {
    return structuredClone(this.#runs.slice(-limit));
  }
}

/** A value SQLite stores in one column. */
export type RosterSqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the store uses: synchronous SQL and
 * synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface RosterSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: RosterSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The tables the Durable Object store writes. Exported so tests and migrations can name them. */
export const ROSTER_SYNC_TABLES = {
  state: "educateos_roster_sync_state",
  chunks: "educateos_roster_sync_state_chunks",
  runs: "educateos_roster_sync_runs",
} as const;

// Durable Object SQLite caps a value at 2 MB, and a large district's state is bigger, so the state's
// JSON is stored in chunks well under the cap. A chunk is a slice of a JavaScript string, so a
// character never straddles two of them.
const CHUNK_LENGTH = 512 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ROSTER_SYNC_TABLES.state} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${ROSTER_SYNC_TABLES.chunks} (
    part INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ${ROSTER_SYNC_TABLES.runs} (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_json TEXT NOT NULL
  )`,
];

/** Thrown when stored state cannot be read back. A sync refuses to run over state it cannot read. */
export class RosterStoreCorruptionError extends Error {
  override readonly name = "RosterStoreCorruptionError";
}

const StateRow = z.object({ version: z.number().int().positive(), chunk_count: z.number().int().nonnegative() });
const ChunkRow = z.object({ part: z.number().int().nonnegative(), data: z.string() });
const RunRow = z.object({ run_json: z.string() });

/**
 * A {@link RosterSyncStore} in a SQLite-backed Durable Object's storage, one object per district
 * integration. It names the storage it needs structurally and imports nothing from
 * `cloudflare:workers`, so the hosting Worker chooses its own Durable Object class around it.
 *
 * `commit` checks the version and writes the state and the run inside one `transactionSync`, so a
 * commit is all or nothing and two syncs cannot both replace the state. A stored state or run that
 * no longer parses is refused rather than synced over.
 */
export class DurableObjectRosterSyncStore implements RosterSyncStore {
  readonly #storage: RosterSqlStorage;
  #ready = false;

  constructor(storage: RosterSqlStorage) {
    this.#storage = storage;
  }

  async load(): Promise<StoredRosterSync | undefined> {
    return this.#transaction(() => this.#read());
  }

  async commit(run: IntegrationSyncRun, next: RosterSyncState | undefined, expectedVersion: number | undefined): Promise<number | undefined> {
    const runJson = JSON.stringify(IntegrationSyncRun.parse(run));
    const stateJson = next === undefined ? undefined : JSON.stringify(StoredRosterSyncState.parse(next));
    return this.#transaction(() => {
      const { sql } = this.#storage;
      let version = this.#version();
      if (stateJson !== undefined) {
        if (version !== expectedVersion) throw staleCommit();
        version = (expectedVersion ?? 0) + 1;
        const chunks = Array.from({ length: Math.ceil(stateJson.length / CHUNK_LENGTH) }, (_, i) =>
          stateJson.slice(i * CHUNK_LENGTH, (i + 1) * CHUNK_LENGTH)
        );
        sql.exec(`DELETE FROM ${ROSTER_SYNC_TABLES.chunks}`);
        chunks.forEach((data, part) => sql.exec(`INSERT INTO ${ROSTER_SYNC_TABLES.chunks} (part, data) VALUES (?, ?)`, part, data));
        sql.exec(
          `INSERT INTO ${ROSTER_SYNC_TABLES.state} (id, version, chunk_count) VALUES (1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET version = excluded.version, chunk_count = excluded.chunk_count`,
          version,
          chunks.length,
        );
      }
      sql.exec(`INSERT INTO ${ROSTER_SYNC_TABLES.runs} (run_json) VALUES (?)`, runJson);
      sql.exec(
        `DELETE FROM ${ROSTER_SYNC_TABLES.runs} WHERE seq <= (SELECT MAX(seq) FROM ${ROSTER_SYNC_TABLES.runs}) - ?`,
        MAX_STORED_RUNS,
      );
      return version;
    });
  }

  async runs(limit = MAX_STORED_RUNS): Promise<IntegrationSyncRun[]> {
    const rows = this.#transaction(() =>
      this.#storage.sql.exec(`SELECT run_json FROM ${ROSTER_SYNC_TABLES.runs} ORDER BY seq DESC LIMIT ?`, limit).toArray()
    );
    return rows.toReversed().map((raw) => {
      const row = RunRow.safeParse(raw);
      const run = row.success ? IntegrationSyncRun.safeParse(parseJson(row.data.run_json)) : undefined;
      if (run?.success !== true) throw new RosterStoreCorruptionError("a stored roster sync run cannot be read");
      return run.data;
    });
  }

  #transaction<T>(closure: () => T): T {
    return this.#storage.transactionSync(() => {
      if (!this.#ready) for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      this.#ready = true;
      return closure();
    });
  }

  #version(): number | undefined {
    const [raw] = this.#storage.sql.exec(`SELECT version, chunk_count FROM ${ROSTER_SYNC_TABLES.state} WHERE id = 1`).toArray();
    if (raw === undefined) return undefined;
    const row = StateRow.safeParse(raw);
    if (!row.success) throw new RosterStoreCorruptionError("the stored roster sync state cannot be read");
    return row.data.version;
  }

  #read(): StoredRosterSync | undefined {
    const [raw] = this.#storage.sql.exec(`SELECT version, chunk_count FROM ${ROSTER_SYNC_TABLES.state} WHERE id = 1`).toArray();
    if (raw === undefined) return undefined;
    const row = StateRow.safeParse(raw);
    const chunks = z.array(ChunkRow).safeParse(
      this.#storage.sql.exec(`SELECT part, data FROM ${ROSTER_SYNC_TABLES.chunks} ORDER BY part`).toArray(),
    );
    const complete = row.success && chunks.success && chunks.data.length === row.data.chunk_count
      && chunks.data.every((chunk, index) => chunk.part === index);
    const state = complete ? StoredRosterSyncState.safeParse(parseJson(chunks.data.map((c) => c.data).join(""))) : undefined;
    // Never quote the stored state: it holds roster PII.
    if (!row.success || state?.success !== true) throw new RosterStoreCorruptionError("the stored roster sync state cannot be read");
    return { version: row.data.version, state: state.data };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Everything a stored sync needs beyond what the store holds. */
export interface StoredRosterSyncInput extends Omit<RosterSyncInput, "state"> {
  /** Where the state and run history are kept. */
  store: RosterSyncStore;
  /** The state to start from when the store holds none: the district's directory before any import. */
  initial: () => RosterSyncState;
  /**
   * Runs after a sync's state is committed, for what must follow every roster apply (such as
   * reconciling course grants). It is not run for a failed sync. If it throws, the sync stays
   * committed and the error is passed on; it must therefore be safe to run again.
   */
  afterApply?: (result: RosterSyncResult) => Promise<void>;
}

/**
 * Runs one sync over a store: loads the state, runs {@link runRosterSync}, commits the run (and the
 * next state, when the run succeeded) against the version it loaded, then runs `afterApply`.
 *
 * @throws EducateOsError `conflict` when another sync committed first; nothing from this one is kept.
 */
export async function runStoredRosterSync(input: StoredRosterSyncInput): Promise<RosterSyncResult & { version: number | undefined }> {
  const { store, initial, afterApply, ...sync } = input;
  const stored = await store.load();
  const result = await runRosterSync({ ...sync, state: stored?.state ?? initial() });
  const succeeded = result.run.outcome === "succeeded";
  const version = await store.commit(result.run, succeeded ? result.state : undefined, stored?.version);
  if (succeeded) await afterApply?.(result);
  return { ...result, version };
}

const finished = (run: IntegrationSyncRun) => Date.parse(run.finishedAt);

/**
 * The sync that is due at `now` under a schedule (the contracts `RosterSyncSchedule`, which a
 * configuration revision stores under `rostering.schedule`), if any. A complete sync is due when none has succeeded within
 * `completeEveryHours` (so always before the first); otherwise a delta, when the source can read
 * one. Either waits until `deltaEveryMinutes` have passed since the last run of any kind, so a
 * failing source is retried at that interval rather than continuously.
 */
export function dueRosterSync(
  schedule: RosterSyncSchedule,
  runs: readonly IntegrationSyncRun[],
  modes: readonly SyncMode[],
  now: Date,
): SyncMode | undefined {
  const { deltaEveryMinutes, completeEveryHours } = RosterSyncSchedule.parse(schedule);
  const lastRun = Math.max(-Infinity, ...runs.map(finished));
  const lastComplete = Math.max(-Infinity, ...runs.filter((r) => r.mode === "complete" && r.outcome === "succeeded").map(finished));
  const since = (at: number) => now.getTime() - at;
  const retryWait = deltaEveryMinutes * 60_000;
  if (since(lastRun) < retryWait) return undefined;
  if (since(lastComplete) >= completeEveryHours * 3_600_000) return "complete";
  return modes.includes("delta") ? "delta" : undefined;
}
