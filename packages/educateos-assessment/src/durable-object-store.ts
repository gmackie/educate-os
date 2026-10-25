// The Durable Object implementation of `AssessmentRecordStore`, published as its own entry point
// (`@educateos/assessment/durable-object-store`). Like the AI ledger's store
// (`@educateos/ai-governance/durable-object-store`), it names the storage it needs structurally and
// imports nothing from `cloudflare:workers`, so the package's main entry stays runtime-agnostic and
// the Worker hosting a district's records chooses its own Durable Object class around it.
import { EducateOsError } from "@educateos/contracts";
import { AssessmentState } from "./model.ts";
import { assertAssessmentInvariants, type AssessmentRecordStore, type StoredAssessment } from "./store.ts";

/** A value SQLite stores in one column. */
export type SqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the EducateOS assessment stores use:
 * synchronous SQL and synchronous transactions. `DurableObjectStorage` satisfies it as it is.
 */
export interface DurableSqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The table the district's assessment records are kept in. Exported so tests and migrations can name it. */
export const ASSESSMENT_RECORDS_TABLE = "educateos_assessment_records";

// One row: the whole state and the version optimistic concurrency checks against.
const SCHEMA = `CREATE TABLE IF NOT EXISTS ${ASSESSMENT_RECORDS_TABLE} (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL
)`;

const EMPTY: AssessmentState = { assignments: [], starterMaterials: [], submissions: [], feedback: [], gradeProposals: [], gradeVersions: [] };

/** Thrown when the stored records cannot be read. Nothing is decided on records that cannot be read. */
export class AssessmentRecordCorruptionError extends Error {
  override readonly name = "AssessmentRecordCorruptionError";
}

/**
 * An {@link AssessmentRecordStore} in a SQLite-backed Durable Object's storage: one object per
 * district. `commit` reads the stored version and state, checks the expected version and the
 * record invariants (`assertAssessmentInvariants`), and writes, all inside one `transactionSync`
 * with no `await` in between. Two commits from the same version therefore cannot both succeed: the
 * object runs one synchronous block at a time, so the second sees the first's version and answers
 * `conflict`.
 */
export class DurableObjectAssessmentRecordStore implements AssessmentRecordStore {
  readonly #storage: DurableSqlStorage;

  constructor(storage: DurableSqlStorage) {
    this.#storage = storage;
  }

  async load(): Promise<StoredAssessment> {
    return this.#storage.transactionSync(() => this.#read());
  }

  async commit(next: AssessmentState, expectedVersion: number): Promise<void> {
    const parsed = AssessmentState.parse(next);
    this.#storage.transactionSync(() => {
      const current = this.#read();
      if (current.version !== expectedVersion) {
        throw new EducateOsError("conflict", "The assessment records changed while this request was in progress; retry it.");
      }
      assertAssessmentInvariants(current.state, parsed);
      this.#storage.sql.exec(
        `INSERT INTO ${ASSESSMENT_RECORDS_TABLE} (id, version, state_json) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json`,
        current.version + 1,
        JSON.stringify(parsed),
      );
    });
  }

  #read(): StoredAssessment {
    this.#storage.sql.exec(SCHEMA);
    const [row] = this.#storage.sql.exec(`SELECT version, state_json FROM ${ASSESSMENT_RECORDS_TABLE} WHERE id = 1`).toArray();
    if (row === undefined) return { version: 0, state: structuredClone(EMPTY) };
    if (typeof row.version !== "number" || typeof row.state_json !== "string") throw new AssessmentRecordCorruptionError("the assessment records row has an unexpected shape");
    let json: unknown;
    try {
      json = JSON.parse(row.state_json);
    } catch {
      throw new AssessmentRecordCorruptionError("the assessment records are not JSON");
    }
    const state = AssessmentState.safeParse(json);
    if (!state.success) throw new AssessmentRecordCorruptionError("the assessment records do not match their schema");
    return { version: row.version, state: state.data };
  }
}
