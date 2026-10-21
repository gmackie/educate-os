// The district AI ledger as a Durable Object: one object per district, named by its ID, holding an
// `AiLedger` over `DurableObjectLedgerStore`. The ledger decides inside the object, against state
// the object reads from the deployment's configuration, so nothing a caller sends says which pools,
// policy or models apply.

import { DurableObject } from "cloudflare:workers";
import { SchoolOsError, type Scope } from "@schoolos/contracts";
import {
  AiLedger,
  type AiGovernanceSource,
  type AiPrincipal,
  type AiSettlement,
  type AiWorkspaceContext,
  type FundingPurpose,
  type ModelRef,
  type RequestRecord,
  type ReserveResult,
  type SettleResult,
  type UsdNano,
  type VoidResult,
} from "@schoolos/ai-governance";
import { DurableObjectLedgerStore } from "@schoolos/ai-governance/durable-object-store";
import { readGuardConfig, type GuardConfig } from "./config.ts";

/**
 * An {@link AiGovernanceSource} over the deployment's configuration. Every scope resolves to the
 * district policy floor: narrower policy layers arrive with the district app's policy compiler.
 */
export class ConfiguredGovernanceSource implements AiGovernanceSource {
  readonly #config: GuardConfig;

  constructor(config: GuardConfig) {
    this.#config = config;
  }

  async directory() {
    return this.#config.directory;
  }
  async fundingPools() {
    return this.#config.fundingPools;
  }
  async termClosures() {
    return this.#config.termClosures;
  }
  async modelCatalog() {
    return this.#config.modelCatalog;
  }
  async effectivePolicy(_scope: Scope) {
    return this.#config.policy;
  }
}

/** What to hold for one request: the arguments of `AiLedger.reserve`. */
export interface ReserveRequest {
  /** The ledger request ID; the guard uses the Workshop call ID, or a moderation check's ID. */
  requestId: string;
  principal: AiPrincipal;
  workspace: AiWorkspaceContext;
  model: ModelRef;
  estimatedMaxUsdNano: UsdNano;
  fundingPurpose: FundingPurpose;
}

/** How a settlement ended, with a settlement the ledger refused reported rather than thrown. */
export type LedgerSettleResult = SettleResult | { outcome: "not-found" } | { outcome: "conflict" };

/**
 * One district's ledger. Every method is idempotent on its request ID (see `AiLedger`), so a
 * retried call is never billed twice. Only the guard Worker reaches it; inputs are still parsed
 * with the ledger's strict schemas, which is what keeps content out of every entry.
 */
export class DistrictAiLedger extends DurableObject<Cloudflare.Env> {
  #ledger: { text: string; ledger: AiLedger } | undefined;
  readonly #store: DurableObjectLedgerStore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new DurableObjectLedgerStore(ctx.storage);
  }

  /** Holds funds for a request, or refuses it before anything is spent. */
  async reserve(request: ReserveRequest): Promise<ReserveResult> {
    const { requestId, principal, workspace, model, estimatedMaxUsdNano, fundingPurpose } = request;
    return this.#current().reserve(requestId, principal, workspace, model, estimatedMaxUsdNano, { fundingPurpose });
  }

  /** Records what a reserved request cost. */
  async settle(requestId: string, settlement: AiSettlement): Promise<LedgerSettleResult> {
    try {
      return await this.#current().settle(requestId, settlement);
    } catch (error) {
      if (error instanceof SchoolOsError && (error.code === "not-found" || error.code === "conflict")) return { outcome: error.code };
      throw error;
    }
  }

  /** Releases a request's hold. */
  async void(requestId: string): Promise<VoidResult> {
    return this.#current().void(requestId);
  }

  /** Where one request stands, or `null` if it was never reserved. */
  async request(requestId: string): Promise<RequestRecord | null> {
    return (await this.#store.read()).request(requestId) ?? null;
  }

  // The ledger over the current configuration. The store outlives a configuration change: entries
  // are history, and only the state new decisions are made against changes.
  #current(): AiLedger {
    const text = this.env.AI_GUARD_CONFIG;
    if (this.#ledger?.text !== text) {
      const config = readGuardConfig(text);
      this.#ledger = { text, ledger: new AiLedger({ districtId: config.districtId, store: this.#store, source: new ConfiguredGovernanceSource(config) }) };
    }
    return this.#ledger.ledger;
  }
}
