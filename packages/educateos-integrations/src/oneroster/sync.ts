// Roster sync runs over any source that yields the OneRoster row model: complete and delta syncs,
// the roster mirror a delta is laid over, and the run record each sync leaves. New for EducateOS.
import { EducateOsError, type IntegrationSyncRun, type SyncCounts, type SyncErrorCode, type SyncMode } from "@educateos/contracts";
import { z } from "zod";
import { RosterSyncError } from "../sync-run.ts";
import { readOneRosterCsv } from "./feed.ts";
import type { OneRosterCsvFiles, OneRosterCsvLimits, OneRosterFeed, OneRosterHighWater, OneRosterIssue } from "./feed.ts";
import { applyOneRosterFeed } from "./import.ts";
import type { OneRosterChanges, OneRosterFormat, OneRosterImportConfig, OneRosterPreview, RosterState } from "./import.ts";
import { ONEROSTER_FILES, ROW_SCHEMAS } from "./spec.ts";
import type { OneRosterFile, OneRosterRecord } from "./spec.ts";

/**
 * Where each file's next delta starts, as ISO 8601 UTC, keyed by row-model file. A delta reads a
 * file with no cursor whole, which is always safe: a delta never deactivates what it does not list.
 */
export const RosterCursors = z.partialRecord(z.enum(ONEROSTER_FILES), z.iso.datetime());
/** Roster cursors. */
export type RosterCursors = z.infer<typeof RosterCursors>;

/**
 * How far behind each file's newest `dateLastModified` its next delta starts. A record can be
 * stamped before a read but committed after it (a write in flight while the collection is paged),
 * so starting exactly at the newest stamp seen could skip it. Re-reading records is harmless: a
 * delta is idempotent.
 */
export const DELTA_OVERLAP_MS = 5 * 60_000;

/** What a sync asks a source for. */
export interface RosterReadRequest {
  /** Whether to read the whole roster or only what changed. */
  mode: SyncMode;
  /** For a delta, where each file starts. A file with no cursor is read whole. */
  since?: RosterCursors;
}

/** What a source read. */
export interface RosterBatch {
  /** The mode it was read in. */
  mode: SyncMode;
  /** The rows read. For a delta, only the records that changed. */
  feed: OneRosterFeed;
  /** Problems found reading. An `error` among them stops the sync. */
  issues: OneRosterIssue[];
  /** Each file's latest `dateLastModified` among the records read, when the source reports them. */
  highWater?: OneRosterHighWater;
}

/**
 * Where a roster comes from. Every source yields the same row model, so a district can move from a
 * bulk CSV export to a REST server, or back, without anything downstream changing.
 */
export interface RosterSource {
  /** What kind of source this is, such as `oneroster-csv`. */
  readonly kind: string;
  /** How the source delivers records, which decides how import issues name where a record is. */
  readonly format: OneRosterFormat;
  /** The modes it can read in. Every source can read a complete roster. */
  readonly modes: readonly SyncMode[];
  /**
   * Reads the roster. A failure to read is thrown as a `RosterSyncError`; problems with individual
   * records are returned as issues instead.
   */
  read(request: RosterReadRequest): Promise<RosterBatch>;
}

/**
 * A source serving one OneRoster bulk CSV export. It reads complete rosters only (the CSV path
 * refuses delta exports), and reports each file's latest `dateLastModified`, so a REST delta can
 * follow a CSV import.
 */
export function csvRosterSource(files: OneRosterCsvFiles, limits?: OneRosterCsvLimits): RosterSource {
  return {
    kind: "oneroster-csv",
    format: "csv",
    modes: ["complete"],
    read: async (request) => {
      if (request.mode !== "complete") throw new RosterSyncError("delta-unsupported", "a CSV export is read whole");
      return { mode: "complete", ...readOneRosterCsv(files, limits) };
    },
  };
}

/**
 * The roster's rows as the last successful sync left them, without row numbers. A delta is laid
 * over it and the result imported as a complete feed, so a delta shares every rule of the complete
 * path and a record the delta does not list keeps its last known state.
 *
 * It holds only the fields the row model reads: never passwords, phone numbers or demographics.
 */
export const RosterMirror = z.strictObject(
  Object.fromEntries(ONEROSTER_FILES.map((file) => [file, z.array(ROW_SCHEMAS[file])])) as {
    [F in OneRosterFile]: z.ZodArray<(typeof ROW_SCHEMAS)[F]>;
  },
);
/** A roster mirror. */
export type RosterMirror = { [F in OneRosterFile]: OneRosterRecord<F>[] };

/** Everything a roster integration keeps between syncs. */
export interface RosterSyncState {
  /** The directory and its source map. */
  roster: RosterState;
  /** The roster's rows. Absent until a complete sync succeeds. */
  mirror?: RosterMirror;
  /** Where each file's next delta starts. Changes only when a sync succeeds. */
  cursors?: RosterCursors;
}

/** Everything one sync needs. */
export interface RosterSyncInput {
  /** The state the last sync left. */
  state: RosterSyncState;
  /** Where to read the roster. */
  source: RosterSource;
  /** Whether to read the whole roster or only what changed. */
  mode: SyncMode;
  /** How the roster relates to the IdP. */
  config: OneRosterImportConfig;
  /** The run's ID. */
  runId: string;
  /** The time. Read when the run starts, which also dates term states, and when it finishes. */
  clock: () => Date;
}

/** The outcome of a sync. */
export interface RosterSyncResult {
  /** The run record to keep. */
  run: IntegrationSyncRun;
  /** The state to keep: the next one when the run succeeded, else exactly the state given. */
  state: RosterSyncState;
  /** The import's preview, when the run got as far as mapping the feed. */
  preview?: OneRosterPreview;
}

/**
 * Runs one sync: reads the source, imports what it read, and returns the run record and the state
 * to keep.
 *
 * A complete sync imports the feed as the whole roster, so a roster record it does not list is
 * deactivated or retained as `import.ts` describes. A delta updates only the records it lists: one
 * marked `tobedeleted` is deactivated, and absence never deactivates anything.
 *
 * A run is deterministic and idempotent: the same state and source always give the same result,
 * and running the same delta again, or a complete sync of an unchanged roster, changes nothing.
 * Nothing is applied and the cursors stay where they were unless the whole feed applies.
 *
 * A failure to read, or a feed that does not apply, is returned as a failed run. Invalid state or
 * configuration is a caller error and is thrown.
 */
export async function runRosterSync(input: RosterSyncInput): Promise<RosterSyncResult> {
  const { state, source, mode, config } = input;
  const startedAt = input.clock();
  const mirror = state.mirror === undefined ? undefined : parseState(RosterMirror, state.mirror, "roster mirror");
  const previousCursors = state.cursors === undefined ? undefined : parseState(RosterCursors, state.cursors, "cursors");

  const finish = (outcome: { errorCode: SyncErrorCode; preview?: OneRosterPreview } | { next: RosterSyncState; preview: OneRosterPreview }): RosterSyncResult => {
    const failed = "errorCode" in outcome;
    const cursor = earliest(failed ? previousCursors : outcome.next.cursors);
    const run: IntegrationSyncRun = {
      id: input.runId,
      mode,
      ...(cursor === undefined ? {} : { cursor }),
      startedAt: startedAt.toISOString(),
      finishedAt: input.clock().toISOString(),
      counts: failed ? countsOf(undefined) : countsOf(outcome.preview.changes),
      ...(outcome.preview === undefined ? {} : { quarantined: outcome.preview.quarantined.length }),
      outcome: failed ? "failed" : "succeeded",
      ...(failed ? { errorCode: outcome.errorCode } : {}),
    };
    return {
      run,
      state: failed ? state : outcome.next,
      ...(outcome.preview === undefined ? {} : { preview: outcome.preview }),
    };
  };

  if (!source.modes.includes(mode)) return finish({ errorCode: "delta-unsupported" });
  if (mode === "delta" && mirror === undefined) return finish({ errorCode: "no-baseline" });

  let batch: RosterBatch;
  try {
    batch = await source.read(mode === "delta" ? { mode, since: previousCursors ?? {} } : { mode });
  } catch (error) {
    if (error instanceof RosterSyncError) return finish({ errorCode: error.code });
    throw error;
  }
  if (batch.mode !== mode) throw new RosterSyncError("internal-error", `source ${source.kind} answered a ${mode} read with a ${batch.mode} batch`);

  const read = stripRows(batch.feed);
  const records = mode === "complete" ? read : overlay(mirror!, read);
  const result = await applyOneRosterFeed({
    current: state.roster,
    // A complete feed keeps the source's own row numbers, such as a CSV file's.
    feed: mode === "complete" ? batch.feed : numberRows(records),
    issues: batch.issues,
    config,
    now: startedAt,
    format: source.format,
  });
  if (!result.applied) return finish({ errorCode: "feed-rejected", preview: result.preview });
  const cursors = nextCursors(mode, previousCursors ?? {}, batch.highWater ?? {});
  return finish({
    next: { roster: result.next, mirror: records, ...(Object.keys(cursors).length === 0 ? {} : { cursors }) },
    preview: result.preview,
  });
}

/**
 * The cursors after a sync that applied. Each file starts {@link DELTA_OVERLAP_MS} before the newest
 * record read from it. A complete sync replaces the whole roster, so its marks replace the old
 * cursors, even earlier ones (an older export sets the roster back, and the next delta must
 * re-read what it rolled back). A delta only moves a file's cursor forward, and keeps the cursor of
 * a file it read nothing new from.
 *
 * Cursors are kept per file because collections are read one after another: a record modified
 * after its collection was read but stamped earlier than a later collection's newest record would
 * be skipped by a single, roster-wide high-water mark.
 */
export function nextCursors(mode: SyncMode, previous: RosterCursors, highWater: OneRosterHighWater): RosterCursors {
  const next: RosterCursors = mode === "complete" ? {} : { ...previous };
  for (const file of ONEROSTER_FILES) {
    const mark = highWater[file];
    if (mark === undefined) continue;
    const start = Date.parse(mark) - DELTA_OVERLAP_MS;
    const kept = next[file];
    if (kept === undefined || start > Date.parse(kept)) next[file] = new Date(start).toISOString();
  }
  return next;
}

/**
 * Lays a delta's records over the mirror: a record the delta lists replaces the mirrored one in
 * place, a new one is added after the rest, and every other record stays. A user the delta lists
 * brings all of their roles, so their mirrored roles are replaced as a set.
 */
export function overlay(mirror: RosterMirror, delta: RosterMirror): RosterMirror {
  const next = {} as Record<OneRosterFile, unknown[]>;
  for (const file of ONEROSTER_FILES) {
    if (file === "roles.csv") continue;
    const rows = mirror[file] as { sourcedId: string }[];
    const changed = new Map((delta[file] as { sourcedId: string }[]).map((row) => [row.sourcedId, row]));
    const merged = rows.map((row) => {
      const replacement = changed.get(row.sourcedId);
      changed.delete(row.sourcedId);
      return replacement ?? row;
    });
    next[file] = [...merged, ...changed.values()];
  }
  // A listed user's new roles take the place of their first mirrored role, so that laying the same
  // delta over its own result leaves the order, and so the mirror, unchanged.
  const pending = new Map(delta["users.csv"].map((user) => [user.sourcedId, [] as RosterMirror["roles.csv"]]));
  for (const role of delta["roles.csv"]) pending.get(role.userSourcedId)?.push(role);
  const roles: RosterMirror["roles.csv"] = [];
  const placed = new Set<string>();
  for (const role of mirror["roles.csv"]) {
    const replacement = pending.get(role.userSourcedId);
    if (replacement === undefined) roles.push(role);
    else if (!placed.has(role.userSourcedId)) {
      placed.add(role.userSourcedId);
      roles.push(...replacement);
    }
  }
  for (const [user, replacement] of pending) if (!placed.has(user)) roles.push(...replacement);
  next["roles.csv"] = roles;
  return next as RosterMirror;
}

/** Numbers each file's rows from 1, for a feed with no header row of its own. */
export function numberRows(records: RosterMirror): OneRosterFeed {
  return Object.fromEntries(
    ONEROSTER_FILES.map((file) => [file, records[file].map((record, index) => ({ ...record, row: index + 1 }))]),
  ) as OneRosterFeed;
}

function stripRows(feed: OneRosterFeed): RosterMirror {
  return Object.fromEntries(
    ONEROSTER_FILES.map((file) => [file, feed[file].map(({ row: _row, ...record }) => record)]),
  ) as RosterMirror;
}

/** Where the next delta starts re-reading anything: the earliest cursor, as ISO 8601 UTC. */
function earliest(cursors: RosterCursors | undefined): string | undefined {
  const times = Object.values(cursors ?? {}).map((t) => Date.parse(t));
  return times.length === 0 ? undefined : new Date(Math.min(...times)).toISOString();
}

function entityCounts(change: { added: unknown[]; updated: unknown[]; deactivated: unknown[] } | undefined) {
  return {
    added: change?.added.length ?? 0,
    updated: change?.updated.length ?? 0,
    deactivated: change?.deactivated.length ?? 0,
  };
}

function countsOf(changes: OneRosterChanges | undefined): SyncCounts {
  return {
    schools: entityCounts(changes?.schools),
    terms: entityCounts(changes?.terms),
    courses: entityCounts(changes?.courses),
    offerings: entityCounts(changes?.offerings),
    principals: entityCounts(changes?.principals),
    enrollments: entityCounts(changes?.enrollments),
    roleAssignments: {
      added: changes?.roleAssignments.added.length ?? 0,
      removed: changes?.roleAssignments.removed.length ?? 0,
    },
  };
}

function parseState<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new EducateOsError("validation-failed", `${what} is invalid: ${z.prettifyError(result.error)}`);
  return result.data;
}
