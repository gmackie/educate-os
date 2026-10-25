// The Durable Object implementation of `AssessmentRunStore`, published as its own entry point
// (`@educateos/assessment-ci/durable-object-store`). It uses the same structural storage type as the
// assessment records' store, and imports nothing from `cloudflare:workers`.
import { EducateOsError, type AssessmentRunId } from "@educateos/contracts";
import type { DurableSqlStorage } from "@educateos/assessment/durable-object-store";
import { AssessmentRun } from "./model.ts";
import { assertRunTransition, type AssessmentRunStore } from "./store.ts";

/** The table runs are kept in. Exported so tests and migrations can name it. */
export const ASSESSMENT_RUNS_TABLE = "educateos_assessment_runs";

// The JSON is what is trusted; the other columns copy what it holds so the queue can be read
// through an index without parsing every run.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${ASSESSMENT_RUNS_TABLE} (
    id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    started_at TEXT,
    run_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${ASSESSMENT_RUNS_TABLE}_queue ON ${ASSESSMENT_RUNS_TABLE} (state, queued_at)`,
];

/** Thrown when a stored run cannot be read. Nothing is executed or decided on a run that cannot be read. */
export class AssessmentRunCorruptionError extends Error {
  override readonly name = "AssessmentRunCorruptionError";
}

/**
 * An {@link AssessmentRunStore} in a SQLite-backed Durable Object's storage: one object per
 * district. Each run is one row. `replace` is a compare-and-swap: it reads the stored revision,
 * checks it and the transition (`assertRunTransition`), and writes, inside one `transactionSync`
 * with no `await` in between, so of two workers claiming the same run from the same revision
 * exactly one wins and the other answers `conflict`. Leases are the run's own `startedAt`, so a
 * worker that died mid-run is found by {@link runnable} once its lease expires.
 */
export class DurableObjectAssessmentRunStore implements AssessmentRunStore {
  readonly #storage: DurableSqlStorage;

  constructor(storage: DurableSqlStorage) {
    this.#storage = storage;
  }

  async get(id: AssessmentRunId): Promise<AssessmentRun | undefined> {
    return this.#storage.transactionSync(() => this.#read(id));
  }

  async insert(run: AssessmentRun): Promise<AssessmentRun> {
    const parsed = AssessmentRun.parse(run);
    return this.#storage.transactionSync(() => {
      const existing = this.#read(parsed.id);
      if (existing !== undefined) return existing;
      this.#storage.sql.exec(
        `INSERT INTO ${ASSESSMENT_RUNS_TABLE} (id, revision, state, queued_at, started_at, run_json) VALUES (?, ?, ?, ?, ?, ?)`,
        parsed.id,
        parsed.revision,
        parsed.state,
        parsed.queuedAt,
        parsed.startedAt ?? null,
        JSON.stringify(parsed),
      );
      return parsed;
    });
  }

  async replace(next: AssessmentRun, expectedRevision: number): Promise<void> {
    const parsed = AssessmentRun.parse(next);
    this.#storage.transactionSync(() => {
      const current = this.#read(parsed.id);
      if (current === undefined) throw new EducateOsError("not-found", `Run ${parsed.id} was not found.`);
      if (current.revision !== expectedRevision) throw new EducateOsError("conflict", `Run ${parsed.id} changed since it was read.`);
      assertRunTransition(current, parsed);
      this.#storage.sql.exec(
        `UPDATE ${ASSESSMENT_RUNS_TABLE} SET revision = ?, state = ?, started_at = ?, run_json = ? WHERE id = ? AND revision = ?`,
        parsed.revision,
        parsed.state,
        parsed.startedAt ?? null,
        JSON.stringify(parsed),
        parsed.id,
        expectedRevision,
      );
    });
  }

  async runnable(staleBefore: Date, limit: number): Promise<AssessmentRun[]> {
    const rows = this.#storage.transactionSync(() => {
      this.#ensureSchema();
      return this.#storage.sql.exec(
        `SELECT id, run_json FROM ${ASSESSMENT_RUNS_TABLE}
         WHERE state = 'queued' OR (state = 'running' AND started_at < ?)
         ORDER BY queued_at, id LIMIT ?`,
        staleBefore.toISOString(),
        limit,
      ).toArray();
    });
    return rows.map(parseRow);
  }

  #read(id: AssessmentRunId): AssessmentRun | undefined {
    this.#ensureSchema();
    const [row] = this.#storage.sql.exec(`SELECT id, run_json FROM ${ASSESSMENT_RUNS_TABLE} WHERE id = ?`, id).toArray();
    return row === undefined ? undefined : parseRow(row);
  }

  // Run in every transaction rather than cached: a cached flag would outlive a rolled-back creation.
  #ensureSchema(): void {
    for (const statement of SCHEMA) this.#storage.sql.exec(statement);
  }
}

function parseRow(row: Record<string, unknown>): AssessmentRun {
  if (typeof row.run_json !== "string") throw new AssessmentRunCorruptionError(`run ${String(row.id)} has an unexpected shape`);
  let json: unknown;
  try {
    json = JSON.parse(row.run_json);
  } catch {
    throw new AssessmentRunCorruptionError(`run ${String(row.id)} is not JSON`);
  }
  const run = AssessmentRun.safeParse(json);
  if (!run.success || run.data.id !== row.id) throw new AssessmentRunCorruptionError(`run ${String(row.id)} does not match its schema`);
  return run.data;
}
