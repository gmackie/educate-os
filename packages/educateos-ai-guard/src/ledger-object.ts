// The district AI ledger as a Durable Object: one object per district, named by its ID, holding an
// `AiLedger` over `DurableObjectLedgerStore`. The ledger decides inside the object, against state
// the object reads from the deployment's configuration, so nothing a caller sends says which pools,
// policy or models apply.

import { DurableObject } from "cloudflare:workers";
import { DistrictDirectorySnapshot, EducateOsError, type Scope } from "@educateos/contracts";
import {
  AiLedger,
  billingPeriodOf,
  type AiCostSummary,
  type AiGovernanceSource,
  type BilledCost,
  type BillingPeriod,
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
} from "@educateos/ai-governance";
import { DurableObjectLedgerStore } from "@educateos/ai-governance/durable-object-store";
import { readGuardConfig, type GuardConfig } from "./config.ts";
import type { GuardDirectoryPort } from "./context.ts";

/**
 * An {@link AiGovernanceSource} over the deployment's configuration. The directory is the district
 * app's, through `district` (the `EDUCATEOS_DISTRICT` binding) when there is one, else the
 * configured snapshot. Every scope resolves to the district policy floor: narrower policy layers
 * arrive with the district app's policy compiler.
 */
export class ConfiguredGovernanceSource implements AiGovernanceSource {
  readonly #config: GuardConfig;
  readonly #district: GuardDirectoryPort | undefined;

  constructor(config: GuardConfig, district?: GuardDirectoryPort) {
    this.#config = config;
    this.#district = district;
  }

  async directory(): Promise<DistrictDirectorySnapshot> {
    if (this.#district !== undefined) {
      // Validated again: it crossed a service binding, and funding is decided against it.
      const parsed = DistrictDirectorySnapshot.safeParse(await this.#district.ledgerDirectory());
      if (!parsed.success || parsed.data.district.id !== this.#config.districtId) {
        throw new EducateOsError("unavailable", "The district directory is unavailable.");
      }
      return parsed.data;
    }
    if (this.#config.directory === undefined) throw new EducateOsError("unavailable", "No district directory is configured.");
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

/** A settled request with an unknown cost that its AI Gateway logs may settle. */
export interface OutstandingUnknownCost {
  /** The request. */
  requestId: string;
  /** The model it reserved for. */
  model: ModelRef;
  /** The UTC day it was reserved. */
  day: string;
  /** The gateway log of each of its attempts, in attempt order. */
  gatewayLogIds: string[];
}

/** One month's cost summary as the nightly run last recorded it. Content-free. */
export interface AllocationSnapshot {
  /** The UTC month. */
  period: BillingPeriod;
  /** The instant it describes. */
  asOf: string;
  /** Gross cost, safety spend, unknown-cost liabilities and, with account facts, the net allocation. */
  summary: AiCostSummary;
}

const ALLOCATION_SNAPSHOT_PREFIX = "allocation-snapshot:";

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
      if (error instanceof EducateOsError && (error.code === "not-found" || error.code === "conflict")) return { outcome: error.code };
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

  /**
   * Up to `limit` settled requests whose cost is still unknown and whose every attempt names an AI
   * Gateway log, oldest first: what the nightly reconciliation can settle from the gateway.
   */
  async outstandingUnknownCosts(limit: number): Promise<OutstandingUnknownCost[]> {
    const ledger = await this.#store.read();
    const outstanding: OutstandingUnknownCost[] = [];
    for (const { reservation, settlement } of ledger.requests) {
      if (outstanding.length >= limit) break;
      if (settlement === undefined || !ledger.hasOutstandingUnknownCost(reservation.requestId)) continue;
      const gatewayLogIds = settlement.attempts.map((attempt) => attempt.gatewayLogId);
      if (gatewayLogIds.length === 0 || gatewayLogIds.some((id) => id === undefined)) continue;
      outstanding.push({ requestId: reservation.requestId, model: reservation.model, day: reservation.reservedAt.slice(0, 10), gatewayLogIds: gatewayLogIds as string[] });
    }
    return outstanding;
  }

  /**
   * Reconciles billed costs into adjustment entries (`AiLedger.reconcile`). Idempotent on
   * `reconciliationId`: a re-run appends nothing it already appended. A run ID reused for a changed
   * bill is reported as a conflict rather than thrown.
   */
  async reconcile(reconciliationId: string, billed: BilledCost[]): Promise<{ outcome: "reconciled"; adjustments: number } | { outcome: "conflict" }> {
    try {
      const report = await this.#current().reconcile(reconciliationId, billed);
      return { outcome: "reconciled", adjustments: report.adjustments.length };
    } catch (error) {
      if (error instanceof EducateOsError && error.code === "conflict") return { outcome: "conflict" };
      throw error;
    }
  }

  /**
   * Records the month's cost and allocation snapshot (`AiLedger.costSummary`, with the configured
   * Cloudflare account's allowance and plan fee when there is one) as it stood at `asOf`, keyed by
   * month so the latest run's snapshot replaces the last. Content-free: pool IDs and amounts only.
   * Recording the same snapshot again writes nothing.
   */
  async recordAllocationSnapshot(period: BillingPeriod, asOf: string): Promise<{ written: boolean; snapshot: AllocationSnapshot }> {
    const at = new Date(asOf);
    if (Number.isNaN(at.getTime()) || billingPeriodOf(asOf) !== period) throw new EducateOsError("validation-failed", "asOf must fall in the period");
    const config = readGuardConfig(this.env.AI_GUARD_CONFIG);
    const ledger = new AiLedger({ districtId: config.districtId, store: this.#store, source: this.#source(config), now: () => at });
    const snapshot: AllocationSnapshot = { period, asOf: at.toISOString(), summary: await ledger.costSummary(config.cloudflareAccount) };
    const key = `${ALLOCATION_SNAPSHOT_PREFIX}${period}`;
    const previous = await this.ctx.storage.get<AllocationSnapshot>(key);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(snapshot)) return { written: false, snapshot };
    await this.ctx.storage.put(key, snapshot);
    return { written: true, snapshot };
  }

  /** The month's last recorded allocation snapshot, if any. */
  async allocationSnapshot(period: BillingPeriod): Promise<AllocationSnapshot | null> {
    return (await this.ctx.storage.get<AllocationSnapshot>(`${ALLOCATION_SNAPSHOT_PREFIX}${period}`)) ?? null;
  }

  #source(config: GuardConfig): ConfiguredGovernanceSource {
    return new ConfiguredGovernanceSource(config, this.env.EDUCATEOS_DISTRICT);
  }

  // The ledger over the current configuration. The store outlives a configuration change: entries
  // are history, and only the state new decisions are made against changes.
  #current(): AiLedger {
    const text = this.env.AI_GUARD_CONFIG;
    if (this.#ledger?.text !== text) {
      const config = readGuardConfig(text);
      this.#ledger = { text, ledger: new AiLedger({ districtId: config.districtId, store: this.#store, source: this.#source(config) }) };
    }
    return this.#ledger.ledger;
  }
}
