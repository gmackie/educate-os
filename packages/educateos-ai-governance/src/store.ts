import { LedgerEntry, LedgerIndex } from "./entries.ts";

/** What one atomic ledger step appends, and what it returns to its caller. */
export interface LedgerDecision<T> {
  /** Entries to append together. Empty when the step changes nothing, as a replayed request does. */
  append: LedgerEntry[];
  /** The step's result. */
  result: T;
}

/**
 * Durable storage for one district's ledger. Entries are append-only.
 *
 * `transact` is the only way to write. It runs `decide` against every committed entry and appends
 * what it returns as one step: no other `transact` interleaves, and the entries land together or
 * not at all. That is what stops two concurrent reservations from both spending the same balance,
 * and a retried request from being reserved twice. `decide` is synchronous so an implementation
 * can run it inside a single storage transaction (a Durable Object's `transactionSync`, say).
 * An implementation may instead run steps optimistically, deciding on a snapshot and retrying on
 * fresh state when another step committed first, provided no step ever commits over one it did
 * not see. Pool allocations, principal caps and the protected safety pool all rest on this.
 *
 * `DurableObjectLedgerStore` (`@educateos/ai-governance/durable-object-store`) is the durable
 * implementation; {@link InMemoryLedgerStore} is for tests and the local harness.
 */
export interface LedgerStore {
  /** A snapshot of every committed entry. */
  read(): Promise<LedgerIndex>;
  /** Runs one atomic decide-and-append step. If `decide` throws, nothing is appended. */
  transact<T>(decide: (ledger: LedgerIndex) => LedgerDecision<T>): Promise<T>;
}

/**
 * A {@link LedgerStore} in memory, for tests and the local harness. Each step runs synchronously
 * on one index, so steps cannot interleave. Every appended entry is re-parsed with its strict
 * schema first, so an entry carrying an unexpected field (a prompt, say) is refused, never stored.
 */
export class InMemoryLedgerStore implements LedgerStore {
  #index = new LedgerIndex();

  async read(): Promise<LedgerIndex> {
    return new LedgerIndex(this.#index.entries);
  }

  async transact<T>(decide: (ledger: LedgerIndex) => LedgerDecision<T>): Promise<T> {
    const { append, result } = decide(this.#index);
    const parsed = append.map((entry) => LedgerEntry.parse(entry));
    for (const entry of parsed) this.#index.apply(entry);
    return result;
  }
}
