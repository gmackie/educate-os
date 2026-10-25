import { z } from "zod";
import {
  DistrictId,
  PrincipalId,
  EducateOsError,
  type DistrictDirectorySnapshot,
} from "@educateos/contracts";
import type { PolicySource } from "@educateos/policy";
import {
  AiAttempts,
  AiRequestId,
  AiWorkspaceContext,
  FundingPurpose,
  ModelRef,
  PriceBookId,
  TokenUsage,
  sameModel,
  type AiAttempt,
  type AiDenialReason,
  type GovernedModel,
} from "./model.ts";
import {
  PositiveUsdNano,
  UsdNano,
  signedUsdNano,
  usdNano,
  usdNanoFromCents,
  usdNanoValue,
  type SignedUsdNano,
} from "./money.ts";
import { routeModel } from "./model-policy.ts";
import { resolveFunding, type FundingPool, type TermClosedEvent } from "./pools.ts";
import {
  ENTRY_SCHEMA_VERSION,
  billingPeriodOf,
  type BillingPeriod,
  type LedgerEntry,
  type ReservationEntry,
  type SettlementEntry,
} from "./entries.ts";
import type { LedgerStore } from "./store.ts";
import { usageEventsFrom, usageReport, type AiUsageEvent, type UsageReport } from "./usage.ts";
import { planReconciliation, ReconciliationId, type BilledCost, type ReconciliationReport } from "./reconcile.ts";
import type { CloudflareAccountFacts } from "./account-allocation.ts";
import {
  costSummary,
  fundingReport,
  projectMonthEnd,
  type AiCostSummary,
  type AiFundingReport,
  type AiProjectionReport,
} from "./budgets.ts";

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
  allocationUsdNano: UsdNano;
  /** Settled, held and adjusted charges. */
  chargedUsdNano: SignedUsdNano;
  /** `allocationUsdNano - chargedUsdNano`; negative when settlement or a bill correction overran it. */
  remainingUsdNano: SignedUsdNano;
}

/**
 * How a request ended: every provider attempt it made, and the price book the gateway estimated
 * costs from. The single-attempt form (`usage` and `actualUsdNano`, with `state` defaulting to
 * `estimated`) is shorthand for one attempt at index 0.
 */
export const AiSettlement = z.union([
  z.strictObject({ attempts: AiAttempts, priceBookId: PriceBookId.optional() }),
  z.strictObject({
    usage: TokenUsage,
    actualUsdNano: UsdNano,
    state: z.enum(["provider_reported", "estimated"]).optional(),
    priceBookId: PriceBookId.optional(),
  }),
]);
/** A settlement, as {@link AiLedger.settle} accepts it. */
export type AiSettlement = z.input<typeof AiSettlement>;

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
  estimatedMaxUsdNano: PositiveUsdNano,
  fundingPurpose: FundingPurpose,
});

/** Options for {@link AiLedger.reserve}. */
export interface ReserveOptions {
  /** What the spend is for. Defaults to `generative`. */
  fundingPurpose?: FundingPurpose;
}

/** The attempts and price book of a parsed settlement, in the long form. */
function settlementAttempts(settlement: z.output<typeof AiSettlement>): { attempts: AiAttempt[]; priceBookId?: PriceBookId } {
  const priceBook = settlement.priceBookId === undefined ? {} : { priceBookId: settlement.priceBookId };
  if ("attempts" in settlement) return { attempts: settlement.attempts, ...priceBook };
  const { usage, actualUsdNano, state = "estimated" } = settlement;
  return { attempts: [{ attemptIndex: 0, state, usage, actualUsdNano }], ...priceBook };
}

/** JSON with object keys sorted, so two equal settlements compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => a.localeCompare(b)))
      : inner);
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new EducateOsError("validation-failed", result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 1000));
  }
  return result.data;
}

/** A request's routing: the model, the pools to draw on in order, and the principal's cap. */
type Routing =
  | { ok: true; model: GovernedModel; pools: FundingPool[]; capUsdNano: bigint | undefined }
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
 *
 * Every amount is in {@link UsdNano}. The policy's principal cap is set in whole cents and is
 * converted with `usdNanoFromCents` when it is applied.
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
   * Holds `estimatedMaxUsdNano` for one request, or refuses it before anything is spent.
   *
   * The request must come from a principal of this district, be fundable from their enrollments
   * (see `resolveFunding`), and name a model the policy and a candidate pool allow (see
   * `routeModel`). It is then held against the first candidate pool with enough left this month,
   * provided the principal's month-to-date charges plus the estimate stay within the effective
   * `aiMonthlyCapCentsPerPrincipal`.
   *
   * A `safety` request (see {@link FundingPurpose}) is held only against the district safety pool
   * and is not subject to the principal cap. When that pool has too little left it is refused
   * with `safety-budget-exhausted`, so the caller can block generative AI and offer a path
   * without AI. A generative request never draws on the safety pool.
   *
   * A request ID already reserved returns that reservation and its status. Reusing one for a
   * different principal, workspace, model, estimate or purpose is a `conflict`.
   *
   * The pool and cap checks and the hold are one `LedgerStore.transact` step, so concurrent
   * reservations can never together hold more than a pool's allocation or a principal's cap.
   */
  async reserve(
    requestId: AiRequestId,
    principal: AiPrincipal,
    workspace: AiWorkspaceContext,
    model: ModelRef,
    estimatedMaxUsdNano: UsdNano,
    options: ReserveOptions = {},
  ): Promise<ReserveResult> {
    const fundingPurpose = options.fundingPurpose ?? "generative";
    const input = parsed(ReserveInput, { requestId, principal, workspace, model, estimatedMaxUsdNano, fundingPurpose });
    const estimate = usdNanoValue(input.estimatedMaxUsdNano);
    const reservedAt = this.#now().toISOString();
    const period = billingPeriodOf(reservedAt);
    const decision = await this.#route(input.principal, input.workspace, input.model, input.fundingPurpose);

    return this.#store.transact<ReserveResult>((ledger) => {
      const existing = ledger.request(input.requestId);
      if (existing !== undefined) {
        const held = existing.reservation;
        if (held.principalId !== input.principal.principalId || held.districtId !== input.principal.districtId
          || !sameWorkspace(held.workspace, input.workspace) || !sameModel(held.model, input.model)
          || held.heldUsdNano !== input.estimatedMaxUsdNano || held.fundingPurpose !== input.fundingPurpose) {
          throw new EducateOsError("conflict", "request ID was already used for a different request");
        }
        const status: RequestStatus = existing.settlement ? "settled" : existing.voided ? "voided" : "held";
        return { append: [], result: { outcome: "reserved", reservation: held, replayed: true, status } };
      }
      if (!decision.ok) return { append: [], result: { outcome: "denied", reason: decision.reason } };

      if (decision.capUsdNano !== undefined) {
        const principalCharged = usdNanoValue(ledger.principalCharged(input.principal.principalId, period));
        if (principalCharged + estimate > decision.capUsdNano) {
          return { append: [], result: { outcome: "denied", reason: "principal-cap-reached" } };
        }
      }
      const pool = decision.pools.find((candidate) =>
        usdNanoValue(ledger.poolCharged(candidate.id, period)) + estimate <= usdNanoValue(candidate.monthlyAllocationUsdNano));
      if (pool === undefined) {
        const reason = input.fundingPurpose === "safety" ? "safety-budget-exhausted" : "pool-exhausted";
        return { append: [], result: { outcome: "denied", reason } };
      }

      const reservation: ReservationEntry = {
        type: "reservation",
        entrySchemaVersion: ENTRY_SCHEMA_VERSION,
        requestId: input.requestId,
        districtId: this.#districtId,
        principalId: input.principal.principalId,
        workspace: input.workspace,
        fundingPurpose: input.fundingPurpose,
        poolId: pool.id,
        model: { provider: decision.model.provider, modelId: decision.model.modelId },
        heldUsdNano: input.estimatedMaxUsdNano,
        period,
        reservedAt,
      };
      return { append: [reservation], result: { outcome: "reserved", reservation, replayed: false, status: "held" } };
    });
  }

  /**
   * Records what a reserved request actually cost, replacing its hold.
   *
   * A request may have made several provider attempts (a retry after a timeout is billed again),
   * and each is charged. An attempt whose cost is `unknown` is charged at the reservation's hold,
   * never at $0, and the settlement is flagged `hasUnknownCost` until reconciliation corrects it.
   *
   * Settlement is idempotent on the request ID: settling again with the same attempts and price
   * book returns the first settlement and changes nothing, and settling with anything different
   * is a `conflict`. A request voided first stays voided; if the provider billed it anyway,
   * reconciliation charges it.
   */
  async settle(requestId: AiRequestId, settlement: AiSettlement): Promise<SettleResult> {
    const id = parsed(AiRequestId, requestId);
    const { attempts, priceBookId } = settlementAttempts(parsed(AiSettlement, settlement));
    const settledAt = this.#now().toISOString();
    return this.#store.transact<SettleResult>((ledger) => {
      const record = ledger.request(id);
      if (record === undefined) throw new EducateOsError("not-found", "no reservation for this request");
      if (record.settlement !== undefined) {
        const settled = record.settlement;
        if (canonicalJson([settled.attempts, settled.priceBookId]) !== canonicalJson([attempts, priceBookId])) {
          throw new EducateOsError("conflict", "request was already settled with different attempts");
        }
        return { append: [], result: { outcome: "settled", settlement: settled, replayed: true } };
      }
      if (record.voided !== undefined) return { append: [], result: { outcome: "already-voided" } };
      const held = usdNanoValue(record.reservation.heldUsdNano);
      let charged = 0n;
      for (const attempt of attempts) charged += attempt.state === "unknown" ? held : usdNanoValue(attempt.actualUsdNano);
      const entry: SettlementEntry = {
        type: "settlement",
        entrySchemaVersion: ENTRY_SCHEMA_VERSION,
        requestId: id,
        attempts,
        ...(priceBookId === undefined ? {} : { priceBookId }),
        chargedUsdNano: usdNano(charged),
        hasUnknownCost: attempts.some((attempt) => attempt.state === "unknown"),
        settledAt,
      };
      return { append: [entry], result: { outcome: "settled", settlement: entry, replayed: false } };
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
      const entry: LedgerEntry = { type: "void", entrySchemaVersion: ENTRY_SCHEMA_VERSION, requestId: id, voidedAt };
      return { append: [entry], result: { outcome: "voided", replayed: false } };
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
      const chargedUsdNano = ledger.poolCharged(pool.id, period);
      const remaining = usdNanoValue(pool.monthlyAllocationUsdNano) - usdNanoValue(chargedUsdNano);
      return [pool.id, { allocationUsdNano: pool.monthlyAllocationUsdNano, chargedUsdNano, remainingUsdNano: signedUsdNano(remaining) }];
    }));
  }

  /** Where every pool stands this month, with the safety reserve and its recommended minimum. */
  async fundingReport(options: { districtCapUsdNano?: UsdNano } = {}): Promise<AiFundingReport> {
    const [ledger, pools, snapshot, termClosures] = await Promise.all([
      this.#store.read(),
      this.#source.fundingPools(),
      this.#source.directory(),
      this.#source.termClosures(),
    ]);
    const period = billingPeriodOf(this.#now().toISOString());
    return fundingReport({ ledger, pools, snapshot, termClosures, period, ...options });
  }

  /** Each pool's month-end projection by linear run rate (see `projectMonthEnd`). */
  async projection(): Promise<AiProjectionReport> {
    const [ledger, pools] = await Promise.all([this.#store.read(), this.#source.fundingPools()]);
    return projectMonthEnd(ledger, pools, this.#now());
  }

  /** This month's gross model cost, safety spend and, given account facts, the net estimate (see `costSummary`). */
  async costSummary(account?: CloudflareAccountFacts): Promise<AiCostSummary> {
    const ledger = await this.#store.read();
    const period = billingPeriodOf(this.#now().toISOString());
    return costSummary({ ledger, events: usageEventsFrom(ledger), period, ...(account === undefined ? {} : { account }) });
  }

  async #route(principal: AiPrincipal, workspace: AiWorkspaceContext, model: ModelRef, purpose: FundingPurpose): Promise<Routing> {
    if (principal.districtId !== this.#districtId) return { ok: false, reason: "cross-district" };
    const [snapshot, pools, closures, catalog] = await Promise.all([
      this.#source.directory(),
      this.#source.fundingPools(),
      this.#source.termClosures(),
      this.#source.modelCatalog(),
    ]);
    const funding = resolveFunding(snapshot, pools, closures, principal, workspace, purpose);
    if (!funding.ok) return funding;
    const policy = await this.#source.effectivePolicy(funding.policyScope);
    const route = routeModel(model, { policy, catalog, pools: funding.pools });
    if (!route.ok) return route;
    // Safety spend is organizational, so no principal cap applies to it.
    const capUsdNano = purpose === "safety" ? undefined : usdNanoValue(usdNanoFromCents(policy.aiMonthlyCapCentsPerPrincipal));
    return { ok: true, model: route.model, pools: route.pools, capUsdNano };
  }
}
