import type { DistrictId } from "@schoolos/contracts";
import { IdentityLinkIndex } from "./log-index.ts";
import type { IdentityLinkEntry } from "./records.ts";

/** What one atomic step appends to the log, and what it returns to its caller. */
export interface IdentityLinkStep<T> {
  /** Entries to append together. Empty when the step changes nothing, as a repeated request does. */
  append: IdentityLinkEntry[];
  /** The step's result. */
  result: T;
}

/**
 * Durable storage for one district's identity-link log: its pending identity links and Workshop
 * user adoptions, their decisions and audit events. Entries are append-only.
 *
 * `transact` is the only way to write. It runs `decide` against every committed entry and appends
 * what it returns as one step: no other step interleaves, and the entries land together or not at
 * all. Each entry is folded into a copy of the index with `IdentityLinkIndex.apply` before it is
 * committed, so an entry that breaks a transition (deciding a request twice, adopting one Workshop
 * user into two principals) is refused and rolls the whole step back. `decide` is synchronous so an
 * implementation can run it inside a single storage transaction.
 *
 * `DurableObjectIdentityLinkStore` (`@schoolos/identity-links/durable-object-store`) is the durable
 * implementation, for a district's control Durable Object; {@link InMemoryIdentityLinkStore} is for
 * tests and the local harness.
 */
export interface IdentityLinkStore {
  /** The district whose log this is. */
  readonly districtId: DistrictId;
  /** A snapshot of every committed entry. Changing it changes nothing stored. */
  read(): Promise<IdentityLinkIndex>;
  /** Runs one atomic decide-and-append step. If `decide` or any entry is refused, nothing is appended. */
  transact<T>(decide: (index: IdentityLinkIndex) => IdentityLinkStep<T>): Promise<T>;
}

/**
 * Runs `decide` against `index` and folds what it appends into a copy, returning the copy, the
 * parsed entries and the result. Throws, leaving `index` untouched, if `decide` or any entry does.
 * Shared by both stores, so they enforce exactly the same rules.
 */
export function stageStep<T>(
  index: IdentityLinkIndex,
  decide: (index: IdentityLinkIndex) => IdentityLinkStep<T>,
): { staged: IdentityLinkIndex; appended: IdentityLinkEntry[]; result: T } {
  // `decide` sees a copy, so one that mutates what it was given cannot change committed state.
  const { append, result } = decide(index.clone());
  const staged = index.clone();
  for (const entry of append) staged.apply(entry);
  // `apply` keeps the parsed entry, so what is stored is exactly what passed its strict schema.
  return { staged, appended: staged.entries.slice(index.entries.length), result };
}

/** An {@link IdentityLinkStore} held in memory, for tests and the local harness. */
export class InMemoryIdentityLinkStore implements IdentityLinkStore {
  readonly districtId: DistrictId;
  #index: IdentityLinkIndex;

  constructor(districtId: DistrictId) {
    this.districtId = districtId;
    this.#index = new IdentityLinkIndex(districtId);
  }

  async read(): Promise<IdentityLinkIndex> {
    return this.#index.clone();
  }

  async transact<T>(decide: (index: IdentityLinkIndex) => IdentityLinkStep<T>): Promise<T> {
    const { staged, result } = stageStep(this.#index, decide);
    this.#index = staged;
    return result;
  }
}
