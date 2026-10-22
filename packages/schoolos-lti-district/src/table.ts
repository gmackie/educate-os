/** One stored record: a JSON value, and when it stops counting if it expires. */
export interface TableRow {
  readonly value: unknown;
  /** Milliseconds since the epoch, for values that expire. */
  readonly expiresAt: number | undefined;
}

/**
 * Keyed JSON records in named collections: the storage every district LTI store is written over.
 * One table holds one district's LTI state, so it lives in that district's Durable Object.
 *
 * Every method is synchronous, which is what makes the stores atomic: a store reads, decides and
 * writes inside {@link atomically} with no `await` in between, so two concurrent requests to the
 * object cannot interleave there. A Durable Object runs one synchronous block at a time, and an
 * isolate does the same for the in-memory table.
 */
export interface RecordTable {
  /** The record under `key` in `collection`, expired or not. */
  get(collection: string, key: string): TableRow | undefined;
  /** Stores `value` under `key`, replacing any record there. */
  put(collection: string, key: string, value: unknown, expiresAt?: number): void;
  /** Removes and returns the record under `key`. */
  delete(collection: string, key: string): TableRow | undefined;
  /** Every record in `collection`, in key order. */
  list(collection: string): { key: string; row: TableRow }[];
  /** Removes the records in `collection` that expired at or before `now`. */
  purgeExpired(collection: string, now: number): void;
  /** Runs `step` as one unit: all of its writes are kept, or, if it throws, none is. */
  atomically<T>(step: () => T): T;
}

/** A {@link RecordTable} held in memory, for tests and single-isolate development. */
export class InMemoryRecordTable implements RecordTable {
  #collections = new Map<string, Map<string, { json: string; expiresAt: number | undefined }>>();

  get(collection: string, key: string): TableRow | undefined {
    const stored = this.#collections.get(collection)?.get(key);
    return stored === undefined ? undefined : { value: JSON.parse(stored.json), expiresAt: stored.expiresAt };
  }

  put(collection: string, key: string, value: unknown, expiresAt?: number): void {
    let records = this.#collections.get(collection);
    if (records === undefined) this.#collections.set(collection, (records = new Map()));
    // Stored as JSON, as the SQLite table stores it, so a caller's later edits never reach it.
    records.set(key, { json: JSON.stringify(value), expiresAt });
  }

  delete(collection: string, key: string): TableRow | undefined {
    const row = this.get(collection, key);
    this.#collections.get(collection)?.delete(key);
    return row;
  }

  list(collection: string): { key: string; row: TableRow }[] {
    return [...(this.#collections.get(collection)?.keys() ?? [])]
      .toSorted()
      .map((key) => ({ key, row: this.get(collection, key)! }));
  }

  purgeExpired(collection: string, now: number): void {
    const records = this.#collections.get(collection);
    for (const [key, stored] of records ?? []) if (stored.expiresAt !== undefined && stored.expiresAt <= now) records!.delete(key);
  }

  atomically<T>(step: () => T): T {
    const before = new Map([...this.#collections].map(([name, records]) => [name, new Map(records)]));
    try {
      return step();
    } catch (err) {
      this.#collections = before;
      throw err;
    }
  }
}

/** The JSON encoding of a tuple, used as a record key so no two tuples can collide. */
export const tupleKey = (...parts: readonly string[]): string => JSON.stringify(parts);
