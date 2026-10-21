// Test worker for the workerd suite: a Durable Object that hosts one district ledger over
// `DurableObjectLedgerStore`, the way a deployed ledger Worker does, so concurrent reservations
// arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import { AiLedger, type BillingPeriod, type LedgerEntry, type PoolBalance, type ReserveResult } from "../../src/index.ts";
import { DurableObjectLedgerStore } from "../../src/durable-object-store.ts";
import { AMARA, BIO_FALL, Clock, FakeSource, NF, northfieldPools, SONNET, c } from "../setup.ts";

/** A ledger whose Biology pool holds $1 a month and whose school pool is empty. */
export class TestLedger extends DurableObject {
  readonly #source = new FakeSource();
  readonly #clock = new Clock();
  readonly #ledger: AiLedger;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#source.pools = northfieldPools({ "fpl_nf-bio-fall": { monthlyAllocationUsdNano: c(100) }, "fpl_nf-high": { monthlyAllocationUsdNano: "0" } });
    this.#ledger = new AiLedger({ districtId: NF, store: new DurableObjectLedgerStore(ctx.storage), source: this.#source, now: this.#clock.now });
  }

  /** Holds `cents` for one Biology request by Amara. */
  async reserve(requestId: string, cents: number): Promise<ReserveResult> {
    return this.#ledger.reserve(requestId, AMARA, BIO_FALL, SONNET, c(cents));
  }

  /** Settles a request at `cents`. */
  async settle(requestId: string, cents: number): Promise<void> {
    await this.#ledger.settle(requestId, { usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, actualUsdNano: c(cents) });
  }

  /** Releases a request's hold. */
  async void(requestId: string): Promise<void> {
    await this.#ledger.void(requestId);
  }

  /** Every pool's position in the clock's month. */
  async balances(): Promise<Record<string, PoolBalance>> {
    return this.#ledger.poolBalances(this.#clock.now().toISOString().slice(0, 7) as BillingPeriod);
  }

  /** Every entry, in append order. */
  async entries(): Promise<readonly LedgerEntry[]> {
    return this.#ledger.entries();
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
