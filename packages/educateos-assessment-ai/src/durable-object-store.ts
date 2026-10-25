// The Durable Object implementation of `OptionalRunStore`, published as its own entry point
// (`@educateos/assessment-ai/durable-object-store`). It uses the same structural storage type as the
// other assessment stores, and imports nothing from `cloudflare:workers`.
import type { z } from "zod";
import { EducateOsError, type AssessmentRunId, type SubmissionId } from "@educateos/contracts";
import type { DurableSqlStorage } from "@educateos/assessment/durable-object-store";
import { AiRelease, OptionalRun, TeacherOverride } from "./model.ts";
import { assertOptionalRunTransition, type OptionalRunStore } from "./store.ts";

/** The tables optional runs, overrides and releases are kept in. Exported so tests and migrations can name them. */
export const OPTIONAL_RUN_TABLES = {
  runs: "educateos_optional_runs",
  overrides: "educateos_optional_run_overrides",
  releases: "educateos_optional_run_releases",
} as const;

const { runs: RUNS, overrides: OVERRIDES, releases: RELEASES } = OPTIONAL_RUN_TABLES;

// The JSON is what is trusted; the other columns copy what it holds for lookups. Overrides and
// releases are append-only at the storage layer: triggers refuse any update or delete.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${RUNS} (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    queued_at TEXT NOT NULL,
    run_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${RUNS}_submission ON ${RUNS} (submission_id, queued_at)`,
  `CREATE TABLE IF NOT EXISTS ${OVERRIDES} (seq INTEGER PRIMARY KEY AUTOINCREMENT, submission_id TEXT NOT NULL, override_json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ${OVERRIDES}_submission ON ${OVERRIDES} (submission_id, seq)`,
  `CREATE TABLE IF NOT EXISTS ${RELEASES} (submission_id TEXT NOT NULL, run_id TEXT NOT NULL, release_json TEXT NOT NULL, PRIMARY KEY (submission_id, run_id))`,
  ...[OVERRIDES, RELEASES].flatMap((table) => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END`,
  ]),
];

/** Thrown when a stored row cannot be read. Nothing is decided on records that cannot be read. */
export class OptionalRunCorruptionError extends Error {
  override readonly name = "OptionalRunCorruptionError";
}

/**
 * An {@link OptionalRunStore} in a SQLite-backed Durable Object's storage: one object per district.
 * `replaceRun` is a compare-and-swap inside one `transactionSync` with no `await` between the read
 * and the write, so of two workers claiming the same run from the same revision exactly one wins.
 * Teacher overrides are appended and releases recorded once per run; neither is ever changed.
 */
export class DurableObjectOptionalRunStore implements OptionalRunStore {
  readonly #storage: DurableSqlStorage;

  constructor(storage: DurableSqlStorage) {
    this.#storage = storage;
  }

  async getRun(id: AssessmentRunId): Promise<OptionalRun | undefined> {
    return this.#transaction(() => this.#readRun(id));
  }

  async insertRun(run: OptionalRun): Promise<OptionalRun> {
    const parsed = OptionalRun.parse(run);
    return this.#transaction(() => {
      const existing = this.#readRun(parsed.id);
      if (existing !== undefined) return existing;
      this.#storage.sql.exec(
        `INSERT INTO ${RUNS} (id, submission_id, revision, queued_at, run_json) VALUES (?, ?, ?, ?, ?)`,
        parsed.id,
        parsed.submissionId,
        parsed.revision,
        parsed.queuedAt,
        JSON.stringify(parsed),
      );
      return parsed;
    });
  }

  async replaceRun(next: OptionalRun, expectedRevision: number): Promise<void> {
    const parsed = OptionalRun.parse(next);
    this.#transaction(() => {
      const current = this.#readRun(parsed.id);
      if (current === undefined) throw new EducateOsError("not-found", `Run ${parsed.id} was not found.`);
      if (current.revision !== expectedRevision) throw new EducateOsError("conflict", `Run ${parsed.id} changed since it was read.`);
      assertOptionalRunTransition(current, parsed);
      this.#storage.sql.exec(`UPDATE ${RUNS} SET revision = ?, run_json = ? WHERE id = ? AND revision = ?`, parsed.revision, JSON.stringify(parsed), parsed.id, expectedRevision);
    });
  }

  async runsFor(submissionId: SubmissionId): Promise<OptionalRun[]> {
    const rows = this.#transaction(() => this.#storage.sql.exec(`SELECT run_json AS json FROM ${RUNS} WHERE submission_id = ? ORDER BY queued_at, id`, submissionId).toArray());
    return rows.map((row) => parseJson(OptionalRun, row, "run"));
  }

  async addOverride(override: TeacherOverride): Promise<void> {
    const parsed = TeacherOverride.parse(override);
    this.#transaction(() => {
      this.#storage.sql.exec(`INSERT INTO ${OVERRIDES} (submission_id, override_json) VALUES (?, ?)`, parsed.submissionId, JSON.stringify(parsed));
    });
  }

  async overridesFor(submissionId: SubmissionId): Promise<TeacherOverride[]> {
    const rows = this.#transaction(() => this.#storage.sql.exec(`SELECT override_json AS json FROM ${OVERRIDES} WHERE submission_id = ? ORDER BY seq`, submissionId).toArray());
    return rows.map((row) => parseJson(TeacherOverride, row, "override"));
  }

  async addRelease(release: AiRelease): Promise<void> {
    const parsed = AiRelease.parse(release);
    this.#transaction(() => {
      // Releasing the same run again keeps the first release.
      this.#storage.sql.exec(`INSERT OR IGNORE INTO ${RELEASES} (submission_id, run_id, release_json) VALUES (?, ?, ?)`, parsed.submissionId, parsed.runId, JSON.stringify(parsed));
    });
  }

  async releasesFor(submissionId: SubmissionId): Promise<AiRelease[]> {
    const rows = this.#transaction(() => this.#storage.sql.exec(`SELECT release_json AS json FROM ${RELEASES} WHERE submission_id = ? ORDER BY rowid`, submissionId).toArray());
    return rows.map((row) => parseJson(AiRelease, row, "release"));
  }

  /** Runs `closure` in one transaction, after making sure the tables exist (in that same transaction). */
  #transaction<T>(closure: () => T): T {
    return this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      return closure();
    });
  }

  #readRun(id: AssessmentRunId): OptionalRun | undefined {
    const [row] = this.#storage.sql.exec(`SELECT run_json AS json FROM ${RUNS} WHERE id = ?`, id).toArray();
    if (row === undefined) return undefined;
    const run = parseJson(OptionalRun, row, "run");
    if (run.id !== id) throw new OptionalRunCorruptionError(`run ${id} holds another run`);
    return run;
  }
}

function parseJson<S extends z.ZodType>(schema: S, row: Record<string, unknown>, what: string): z.output<S> {
  if (typeof row.json !== "string") throw new OptionalRunCorruptionError(`a stored ${what} has an unexpected shape`);
  let json: unknown;
  try {
    json = JSON.parse(row.json);
  } catch {
    throw new OptionalRunCorruptionError(`a stored ${what} is not JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new OptionalRunCorruptionError(`a stored ${what} does not match its schema`);
  return parsed.data;
}
