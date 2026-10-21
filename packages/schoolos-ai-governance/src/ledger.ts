import { z } from "zod";
import {
  DistrictId,
  PrincipalId,
  SchoolOsError,
  type DistrictDirectorySnapshot,
} from "@schoolos/contracts";
import type { PolicySource } from "@schoolos/policy";
import {
  AiRequestId,
  AiWorkspaceContext,
  Cents,
  ModelRef,
  TokenUsage,
  sameModel,
  type AiDenialReason,
  type GovernedModel,
} from "./model.ts";
import { routeModel } from "./model-policy.ts";
import { resolveFunding, type FundingPool, type TermClosedEvent } from "./pools.ts";
import {
  billingPeriodOf,
  type BillingPeriod,
  type LedgerEntry,
  type ReservationEntry,
  type SettlementEntry,
} from "./entries.ts";
import type { LedgerStore } from "./store.ts";
import { usageEventsFrom, usageReport, type AiUsageEvent, type UsageReport } from "./usage.ts";
import { planReconciliation, ReconciliationId, type BilledCost, type ReconciliationReport } from "./reconcile.ts";

/**
 * The trusted district state the ledger decides against. Every read is server-side: nothing the
 * requester sent says which pools, policy or models apply to it.
 */
export interface AiGovernanceSource extends PolicySource {
  /** The current academic directory. */
  directory(): Promise<DistrictDirectorySnapshot>;
  /** The district's funding pools. */
  fundingPools(): Promise<FundingPool[]>;
  /** Every term-closed event received from the workspace directory. */
  termClosures(): Promise<TermClosedEvent[]>;
  /** The district gateway's model catalog. */
  modelCatalog(): Promise<GovernedModel[]>;
}

/** The verified principal a request is made for. */
export const AiPrincipal = z.strictObject({ principalId: PrincipalId, districtId: DistrictId });
/** A verified principal. */
export type AiPrincipal = z.infer<typeof AiPrincipal>;

/** Where a reserved request stands. */
export type RequestStatus = "held" | "settled" | "voided";

/** The result of {@link AiLedger.reserve}. */
export type ReserveResult =
  | {
    outcome: "reserved";
    /** The hold, which a replay returns unchanged. */
    reservation: ReservationEntry;
    /** Whether this call found an earlier reservation for the same request instead of holding funds. */
    replayed: boolean;
    /** Where the request stands now. Only a `held` request may still be sent to a model. */
    status: RequestStatus;
  }
  | { outcome: "denied"; reason: AiDenialReason };

/** The result of {@link AiLedger.settle}. */
export type SettleResult =
  | { outcome: "settled"; settlement: SettlementEntry; replayed: boolean }
  | { outcome: "already-voided" };

/** The result of {@link AiLedger.void}. */
export type VoidResult = { outcome: "voided"; replayed: boolean } | { outcome: "already-settled" } | { outcome: "not-found" };

/** A pool's position for one month. */
export interface PoolBalance {
  /** The month's allocation. */
  allocationCents: number;
  /** Settled, held and adjusted charges. */
  chargedCents: number;
  /** `allocationCents - chargedCents`; negative when settlement or a bill correction overran it. */
  remainingCents: number;
}

/** Settings for an {@link AiLedger}. */
export interface AiLedgerOptions {
  /** The district this ledger belongs to. A principal from any other is refused. */
  districtId: DistrictId;
  /** Where entries are kept. */
  store: LedgerStore;
  /** The trusted state requests are decided against. */
  source: AiGovernanceSource;
  /** The current time. Injected so tests can cross month boundaries. */
  now?: () => Date;
}

const ReserveInput = z.strictObject({
  requestId: AiRequestId,
  principal: AiPrincipal,
  workspace: AiWorkspaceContext,
  model: ModelRef,
  estimatedMaxCents: Cents.positive(),
});

const SettleInput = z.strictObject({ requestId: AiRequestId, usage: TokenUsage, actualCents: Cents });

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new SchoolOsError("validation-failed", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 1000));
  }
  return result.data;
}

/** A request's routing: the model, the pools to draw on in order, and the principal's cap. */
type Routing =
  | { ok: true; model: GovernedModel; pools: FundingPool[]; capCents: number }
  | { ok: false; reason: AiDenialReason };

function sameWorkspace(a: AiWorkspaceContext, b: AiWorkspaceContext): boolean {
  return a.kind === b.kind && (a.kind === "personal" || (b.kind === "course" && a.offeringId === b.offeringId));
}

/**
 * One district's AI spend ledger: reserve before a model request, settle or void after it, and
 * reconcile against the provider's bill later (roadmap §8, threat T9).
 *
 * Every operation is idempotent on the request ID. A retried reservation returns the original hold
 * rather than holding again, and a second settlement or void changes nothing, so a retry is never
 * billed twice. Caps and pool balances are checked only when funds are first held: settlement
 * always records the actual cost, even when that overruns a cap, because the spend has happened.
 */
export class AiLedger {
  readonly #districtId: DistrictId;
  readonly #store: LedgerStore;
  readonly #source: AiGovernanceSource;
  readonly #now: () => Date;

  constructor(options: AiLedgerOptions) {
    this.#districtId = options.districtId;
    this.#store = options.store;
    this.#source = options.source;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Holds `estimatedMaxCents` for one request, or refuses it before anything is spent.
   *
   * The request must come from a principal of this district, be fundable from their enrollments
   * (see `resolveFunding`), and name a model the policy and a candidate pool allow (see
   * `routeModel`). It is then held against the first candidate pool with enough left this month,
   * provided the principal's month-to-date charges plus the estimate stay within the effective
   * `aiMonthlyCapCentsPerPrincipal`.
   *
   * A request ID already reserved returns that reservation and its status. Reusing one for a
   * different principal, workspace, model or estimate is a `conflict`.
   */
  async reserve(
    requestId: AiRequestId,
    principal: AiPrincipal,
    workspace: AiWorkspaceContext,
    model: ModelRef,
    estimatedMaxCents: number,
  ): Promise<ReserveResult> {
    const input = parsed(ReserveInput, { requestId, principal, workspace, model, estimatedMaxCents });
    const reservedAt = this.#now().toISOString();
    const period = billingPeriodOf(reservedAt);
    const decision = await this.#route(input.principal, input.workspace, input.model);

    return this.#store.transact<ReserveResult>((ledger) => {
      const existing = ledger.request(input.requestId);
      if (existing !== undefined) {
        const held = existing.reservation;
        if (held.principalId !== input.principal.principalId || held.districtId !== input.principal.districtId
          || !sameWorkspace(held.workspace, input.workspace) || !sameModel(held.model, input.model)
          || held.heldCents !== input.estimatedMaxCents) {
          throw new SchoolOsError("conflict", "request ID was already used for a different request");
        }
        const status: RequestStatus = existing.settlement ? "settled" : existing.voided ? "voided" : "held";
        return { append: [], result: { outcome: "reserved", reservation: held, replayed: true, status } };
      }
      if (!decision.ok) return { append: [], result: { outcome: "denied", reason: decision.reason } };

      const principalCharged = ledger.principalCharged(input.principal.principalId, period);
      if (principalCharged + input.estimatedMaxCents > decision.capCents) {
        return { append: [], result: { outcome: "denied", reason: "principal-cap-reached" } };
      }
      const pool = decision.pools.find((candidate) =>
        ledger.poolCharged(candidate.id, period) + input.estimatedMaxCents <= candidate.monthlyAllocationCents);
      if (pool === undefined) return { append: [], result: { outcome: "denied", reason: "pool-exhausted" } };

      const reservation: ReservationEntry = {
        type: "reservation",
        requestId: input.requestId,
        districtId: this.#districtId,
        principalId: input.principal.principalId,
        workspace: input.workspace,
        poolId: pool.id,
        model: { provider: decision.model.provider, modelId: decision.model.modelId },
        heldCents: input.estimatedMaxCents,
        period,
        reservedAt,
      };
      return { append: [reservation], result: { outcome: "reserved", reservation, replayed: false, status: "held" } };
    });
  }

  /**
   * Records what a reserved request actually cost, replacing its hold. Settling an already-settled
   * request returns the first settlement and changes nothing. A request voided first stays voided;
   * if the provider billed it anyway, reconciliation charges it.
   */
  async settle(requestId: AiRequestId, usage: z.input<typeof TokenUsage>, actualCents: number): Promise<SettleResult> {
    const input = parsed(SettleInput, { requestId, usage, actualCents });
    const settledAt = this.#now().toISOString();
    return this.#store.transact<SettleResult>((ledger) => {
      const record = ledger.request(input.requestId);
      if (record === undefined) throw new SchoolOsError("not-found", "no reservation for this request");
      if (record.settlement !== undefined) {
        return { append: [], result: { outcome: "settled", settlement: record.settlement, replayed: true } };
      }
      if (record.voided !== undefined) return { append: [], result: { outcome: "already-voided" } };
      const settlement: SettlementEntry = { type: "settlement", requestId: input.requestId, usage: input.usage, actualCents: input.actualCents, settledAt };
      return { append: [settlement], result: { outcome: "settled", settlement, replayed: false } };
    });
  }

  /** Releases a failed request's hold. Voiding twice, or after settlement, changes nothing. */
  async void(requestId: AiRequestId): Promise<VoidResult> {
    const id = parsed(AiRequestId, requestId);
    const voidedAt = this.#now().toISOString();
    return this.#store.transact<VoidResult>((ledger) => {
      const record = ledger.request(id);
      if (record === undefined) return { append: [], result: { outcome: "not-found" } };
      if (record.settlement !== undefined) return { append: [], result: { outcome: "already-settled" } };
      if (record.voided !== undefined) return { append: [], result: { outcome: "voided", replayed: true } };
      return { append: [{ type: "void", requestId: id, voidedAt }], result: { outcome: "voided", replayed: false } };
    });
  }

  /**
   * Reconciles a provider bill (see `parseCostExportCsv` and `parseCostExportJson`) and appends the
   * resulting adjustment entries in one atomic step. Settled history is never changed.
   */
  async reconcile(reconciliationId: string, billed: readonly BilledCost[]): Promise<ReconciliationReport> {
    const id = parsed(ReconciliationId, reconciliationId);
    const recordedAt = this.#now().toISOString();
    return this.#store.transact((ledger) => {
      const report = planReconciliation(ledger, id, billed, recordedAt);
      return { append: report.adjustments, result: report };
    });
  }

  /** Every entry, in append order. */
  async entries(): Promise<readonly LedgerEntry[]> {
    return (await this.#store.read()).entries;
  }

  /** One attribution record per settled request. */
  async usageEvents(): Promise<AiUsageEvent[]> {
    return usageEventsFrom(await this.#store.read());
  }

  /** Aggregate usage and cost per principal, offering, pool and model, with the district total. */
  async report(): Promise<UsageReport> {
    const ledger = await this.#store.read();
    return usageReport(usageEventsFrom(ledger), ledger.adjustments);
  }

  /** Each configured pool's position for a month. */
  async poolBalances(period: BillingPeriod): Promise<Record<string, PoolBalance>> {
    const [ledger, pools] = await Promise.all([this.#store.read(), this.#source.fundingPools()]);
    return Object.fromEntries(pools.map((pool) => {
      const chargedCents = ledger.poolCharged(pool.id, period);
      return [pool.id, { allocationCents: pool.monthlyAllocationCents, chargedCents, remainingCents: pool.monthlyAllocationCents - chargedCents }];
    }));
  }

  async #route(principal: AiPrincipal, workspace: AiWorkspaceContext, model: ModelRef): Promise<Routing> {
    if (principal.districtId !== this.#districtId) return { ok: false, reason: "cross-district" };
    const [snapshot, pools, closures, catalog] = await Promise.all([
      this.#source.directory(),
      this.#source.fundingPools(),
      this.#source.termClosures(),
      this.#source.modelCatalog(),
    ]);
    const funding = resolveFunding(snapshot, pools, closures, principal, workspace);
    if (!funding.ok) return funding;
    const policy = await this.#source.effectivePolicy(funding.policyScope);
    const route = routeModel(model, { policy, catalog, pools: funding.pools });
    if (!route.ok) return route;
    return { ok: true, model: route.model, pools: route.pools, capCents: policy.aiMonthlyCapCentsPerPrincipal };
  }
}
