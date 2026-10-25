import type { DistrictDirectorySnapshot, Scope } from "@educateos/contracts";
import {
  CloudflareAccountFacts,
  allocateCloudflareAccounts,
  type AccountUsageEvent,
  type CloudflareAccountId,
} from "./account-allocation.ts";
import { billingPeriodOf, type BillingPeriod, type LedgerIndex } from "./entries.ts";
import { signedUsdNano, usdNano, usdNanoValue, type SignedUsdNano, type UsdNano } from "./money.ts";
import { resolveFunding, type FundingPool, type FundingPoolId, type TermClosedEvent } from "./pools.ts";
import { WORKERS_AI_NEURONS_SKU } from "./price-book.ts";
import type { AiUsageEvent } from "./usage.ts";

// Administrator budget views (Hall Monitor source plan 02 §6 and §9, 03 §7): where each funding
// pool stands this month, the protected safety reserve, a month-end projection, and the month's
// cost split into gross model cost and, where account facts are known, the net estimated bill.
// Everything here is pure and content-free: counts, identifiers and nanodollar amounts.

/**
 * How close a pool is to its allocation: `info` from 70%, `warning` from 85%, `critical` from
 * 95%, and `exhausted` at 100% or more, of the allocation charged or held. A pool with no
 * allocation is `exhausted` once anything is charged to it, and `none` otherwise.
 */
export type BudgetThreshold = "none" | "info" | "warning" | "critical" | "exhausted";

/** The utilization, in basis points, at which each {@link BudgetThreshold} begins. */
export const BUDGET_THRESHOLD_BASIS_POINTS = { info: 7_000, warning: 8_500, critical: 9_500, exhausted: 10_000 } as const;

/** The projected utilization, in basis points, above which a month-end projection is flagged. */
export const PROJECTION_WARNING_BASIS_POINTS = 8_000;

/** The safety reserve's floor: $5 a month, however few people use AI. */
export const SAFETY_RESERVE_MINIMUM_USD_NANO: UsdNano = "5000000000";
/** The safety reserve per active teacher or AI-enabled student: $0.10 a month. */
export const SAFETY_RESERVE_PER_PERSON_USD_NANO: UsdNano = "100000000";

const DAY_MS = 86_400_000;

/** `used / allocation` in whole basis points, rounded down; undefined for a zero allocation. */
function basisPoints(used: bigint, allocation: bigint): number | undefined {
  if (allocation === 0n) return undefined;
  return Number((used < 0n ? 0n : used) * 10_000n / allocation);
}

/** The threshold a pool is at, given what it has used of its allocation. */
export function budgetThreshold(used: SignedUsdNano, allocation: UsdNano): BudgetThreshold {
  const points = basisPoints(usdNanoValue(used), usdNanoValue(allocation));
  if (points === undefined) return usdNanoValue(used) > 0n ? "exhausted" : "none";
  if (points >= BUDGET_THRESHOLD_BASIS_POINTS.exhausted) return "exhausted";
  if (points >= BUDGET_THRESHOLD_BASIS_POINTS.critical) return "critical";
  if (points >= BUDGET_THRESHOLD_BASIS_POINTS.warning) return "warning";
  if (points >= BUDGET_THRESHOLD_BASIS_POINTS.info) return "info";
  return "none";
}

/** A utilization in basis points as a percentage with two decimals (8537 reads 85.37). */
function percent(points: number | undefined): number | null {
  return points === undefined ? null : points / 100;
}

/** One funding pool's position for a month. */
export interface PoolStatus {
  /** The pool. */
  poolId: FundingPoolId;
  /** Its name. */
  name: string;
  /** What it funds. */
  purpose: FundingPool["purpose"];
  /** Where it applies. */
  scope: Scope;
  /** The month's allocation. */
  monthlyAllocationUsdNano: UsdNano;
  /** Settled charges and reconciliation adjustments this month. */
  chargedUsdNano: SignedUsdNano;
  /** Held for requests still in progress this month. */
  heldUsdNano: UsdNano;
  /** `allocation - charged - held`; negative when settlement or a bill correction overran it. */
  remainingUsdNano: SignedUsdNano;
  /** `(charged + held) / allocation` as a percentage, rounded down to 0.01%; null with no allocation. */
  utilizationPercent: number | null;
  /** How close the pool is to its allocation. */
  threshold: BudgetThreshold;
}

/** Each pool's settled-and-adjusted charges and open holds for a period. */
function poolTotals(ledger: LedgerIndex, period: BillingPeriod): Map<string, { charged: bigint; held: bigint }> {
  const totals = new Map<string, { charged: bigint; held: bigint }>();
  const of = (poolId: string) => {
    let entry = totals.get(poolId);
    if (entry === undefined) totals.set(poolId, entry = { charged: 0n, held: 0n });
    return entry;
  };
  for (const { reservation, settlement, voided } of ledger.requests) {
    if (reservation.period !== period) continue;
    if (settlement !== undefined) of(reservation.poolId).charged += usdNanoValue(settlement.chargedUsdNano);
    else if (voided === undefined) of(reservation.poolId).held += usdNanoValue(reservation.heldUsdNano);
  }
  for (const adjustment of ledger.adjustments) {
    if (adjustment.period === period) of(adjustment.poolId).charged += usdNanoValue(adjustment.deltaUsdNano);
  }
  return totals;
}

/**
 * Every pool's position for a month: charged (settled plus reconciliation adjustments) and held
 * (reservations not yet settled or voided) are kept apart, and together are what the ledger checks
 * a new reservation against.
 */
export function poolStatuses(ledger: LedgerIndex, pools: readonly FundingPool[], period: BillingPeriod): PoolStatus[] {
  const totals = poolTotals(ledger, period);
  return pools.map((pool) => {
    const { charged, held } = totals.get(pool.id) ?? { charged: 0n, held: 0n };
    const allocation = usdNanoValue(pool.monthlyAllocationUsdNano);
    const used = signedUsdNano(charged + held);
    return {
      poolId: pool.id,
      name: pool.name,
      purpose: pool.purpose,
      scope: pool.scope,
      monthlyAllocationUsdNano: pool.monthlyAllocationUsdNano,
      chargedUsdNano: signedUsdNano(charged),
      heldUsdNano: usdNano(held),
      remainingUsdNano: signedUsdNano(allocation - charged - held),
      utilizationPercent: percent(basisPoints(charged + held, allocation)),
      threshold: budgetThreshold(used, pool.monthlyAllocationUsdNano),
    };
  });
}

/** Who the safety reserve is sized for, counted from the directory. */
export interface AiPopulation {
  /** Staff teaching (or co-teaching) an active enrollment in a term that is active or grading. */
  activeTeachers: number;
  /** Students some funded generative pool can serve: by a course they are enrolled in, or the personal pool. */
  aiEnabledStudents: number;
}

/**
 * Counts the people the safety reserve protects. A student is AI-enabled when `resolveFunding`
 * would offer a pool with a non-zero allocation for one of their course workspaces or their
 * personal workspace, so the count follows the same enrollment, term and pool rules the ledger
 * enforces.
 */
export function aiPopulation(snapshot: DistrictDirectorySnapshot, pools: readonly FundingPool[], termClosures: readonly TermClosedEvent[]): AiPopulation {
  const funded = pools.filter((pool) => pool.purpose !== "safety" && usdNanoValue(pool.monthlyAllocationUsdNano) > 0n);
  const openTerms = new Set(snapshot.terms
    .filter((term) => (term.state === "active" || term.state === "grading") && !termClosures.some((event) => event.termId === term.id))
    .map((term) => term.id));
  const openOfferings = new Set(snapshot.offerings.filter((offering) => openTerms.has(offering.termId)).map((offering) => offering.id));
  const teachers = new Set(snapshot.enrollments
    .filter((e) => e.status === "active" && e.role !== "student" && openOfferings.has(e.offeringId))
    .map((e) => e.principalId));

  let aiEnabledStudents = 0;
  for (const student of snapshot.principals.filter((p) => p.kind === "student")) {
    const principal = { principalId: student.id, districtId: student.districtId };
    const workspaces = [
      { kind: "personal" as const },
      ...snapshot.enrollments
        .filter((e) => e.principalId === student.id && e.role === "student" && e.status === "active")
        .map((e) => ({ kind: "course" as const, offeringId: e.offeringId })),
    ];
    if (workspaces.some((workspace) => resolveFunding(snapshot, funded, termClosures, principal, workspace).ok)) aiEnabledStudents += 1;
  }
  return { activeTeachers: teachers.size, aiEnabledStudents };
}

/** The recommended safety reserve for a population: max($5, $0.10 × (active teachers + AI-enabled students)). */
export function recommendedSafetyReserveUsdNano(population: AiPopulation): UsdNano {
  const perPerson = usdNanoValue(SAFETY_RESERVE_PER_PERSON_USD_NANO) * BigInt(population.activeTeachers + population.aiEnabledStudents);
  const minimum = usdNanoValue(SAFETY_RESERVE_MINIMUM_USD_NANO);
  return usdNano(perPerson > minimum ? perPerson : minimum);
}

/** The protected safety reserve: the safety pool's position, and what it is recommended to hold. */
export interface SafetyReserveStatus {
  /** The safety pool, when the district has one. Without it, no safety request is funded. */
  pool?: PoolStatus;
  /** Who the reserve is sized for. */
  population: AiPopulation;
  /** max($5, $0.10 × (active teachers + AI-enabled students)). */
  recommendedMinimumUsdNano: UsdNano;
  /** Whether the allocation is below the recommendation (or there is no safety pool). */
  belowRecommended: boolean;
}

/** Where every pool stands this month, with the safety reserve apart from the generative pools. */
export interface AiFundingReport {
  /** The UTC month. */
  period: BillingPeriod;
  /** The course and personal pools, in configuration order. */
  pools: PoolStatus[];
  /** The safety reserve, which no generative request ever draws on. */
  safety: SafetyReserveStatus;
  /** The sum of the course and personal pools' allocations. */
  generativeAllocationUsdNano: UsdNano;
  /** The district's overall monthly cap on generative allocations, when it has one. */
  districtCapUsdNano?: UsdNano;
}

/** Builds an {@link AiFundingReport}. */
export function fundingReport(input: {
  ledger: LedgerIndex;
  pools: readonly FundingPool[];
  snapshot: DistrictDirectorySnapshot;
  termClosures: readonly TermClosedEvent[];
  period: BillingPeriod;
  districtCapUsdNano?: UsdNano;
}): AiFundingReport {
  const statuses = poolStatuses(input.ledger, input.pools, input.period);
  const generative = statuses.filter((status) => status.purpose !== "safety");
  const safetyPool = statuses.find((status) => status.purpose === "safety");
  const population = aiPopulation(input.snapshot, input.pools, input.termClosures);
  const recommendedMinimumUsdNano = recommendedSafetyReserveUsdNano(population);
  return {
    period: input.period,
    pools: generative,
    safety: {
      ...(safetyPool === undefined ? {} : { pool: safetyPool }),
      population,
      recommendedMinimumUsdNano,
      belowRecommended: safetyPool === undefined || usdNanoValue(safetyPool.monthlyAllocationUsdNano) < usdNanoValue(recommendedMinimumUsdNano),
    },
    generativeAllocationUsdNano: usdNano(generative.reduce((sum, pool) => sum + usdNanoValue(pool.monthlyAllocationUsdNano), 0n)),
    ...(input.districtCapUsdNano === undefined ? {} : { districtCapUsdNano: input.districtCapUsdNano }),
  };
}

/** One pool's month-end projection. */
export interface PoolProjection {
  /** The pool. */
  poolId: FundingPoolId;
  /** Its name. */
  name: string;
  /** What it funds. */
  purpose: FundingPool["purpose"];
  /** The month's allocation. */
  monthlyAllocationUsdNano: UsdNano;
  /** Charged and held so far this month. */
  monthToDateUsdNano: SignedUsdNano;
  /** The month-to-date amount at the same rate for the whole month. */
  projectedUsdNano: SignedUsdNano;
  /** `projected / allocation` as a percentage, rounded down to 0.01%; null with no allocation. */
  projectedUtilizationPercent: number | null;
  /** Whether the projection is above 80% of the allocation (or above nothing, with no allocation). */
  flagged: boolean;
}

/** The month-end projection for every pool. */
export interface AiProjectionReport {
  /** The UTC month. */
  period: BillingPeriod;
  /** When it was projected. */
  asOf: string;
  /** How much of the month the run rate is taken over, in days (at least one). */
  elapsedDays: number;
  /** Days in the month. */
  monthDays: number;
  /** The percentage above which a projection is flagged. */
  warningPercent: number;
  /** One per pool, the safety pool included, in configuration order. */
  pools: PoolProjection[];
}

/**
 * Projects each pool's month-end spend by linear run rate: what was charged and held from the start
 * of the UTC month to `now`, divided by the time elapsed and multiplied by the month's length,
 * rounded up to a whole nanodollar. The elapsed time is taken as at least one day, so a few
 * requests in the month's first hour do not project as a month of that pace. A projection above
 * 80% of the allocation is flagged. It is a straight line: term breaks, weekends and the end of
 * a grading period all make it pessimistic.
 */
export function projectMonthEnd(ledger: LedgerIndex, pools: readonly FundingPool[], now: Date): AiProjectionReport {
  const period = billingPeriodOf(now.toISOString());
  const [year, month] = period.split("-").map(Number) as [number, number];
  const start = Date.UTC(year, month - 1, 1);
  const monthMs = Date.UTC(year, month, 1) - start;
  const elapsedMs = Math.min(Math.max(now.getTime() - start, DAY_MS), monthMs);
  const statuses = poolStatuses(ledger, pools, period);
  return {
    period,
    asOf: now.toISOString(),
    elapsedDays: elapsedMs / DAY_MS,
    monthDays: monthMs / DAY_MS,
    warningPercent: PROJECTION_WARNING_BASIS_POINTS / 100,
    pools: statuses.map((status) => {
      const spent = usdNanoValue(status.chargedUsdNano) + usdNanoValue(status.heldUsdNano);
      const scaled = spent * BigInt(monthMs);
      const elapsed = BigInt(elapsedMs);
      const projected = spent > 0n ? (scaled + elapsed - 1n) / elapsed : spent;
      const allocation = usdNanoValue(status.monthlyAllocationUsdNano);
      return {
        poolId: status.poolId,
        name: status.name,
        purpose: status.purpose,
        monthlyAllocationUsdNano: status.monthlyAllocationUsdNano,
        monthToDateUsdNano: signedUsdNano(spent),
        projectedUsdNano: signedUsdNano(projected),
        projectedUtilizationPercent: percent(basisPoints(projected, allocation)),
        flagged: allocation === 0n ? projected > 0n : projected * 10_000n > allocation * BigInt(PROJECTION_WARNING_BASIS_POINTS),
      };
    }),
  };
}

/** The product the district's usage is allocated under in its Cloudflare account. */
export const EDUCATEOS_PRODUCT = "educateos";

/**
 * The month's settled usage events as Cloudflare account usage, one per request, charged back to
 * the pool that paid (the cost center). Workers AI (`cloudflare`) usage is the
 * `workers-ai-neurons` SKU; the ledger keeps money rather than neurons, so its neurons are
 * estimated from the charge at the account's neuron rate, rounded down, which is exact for
 * neuron-priced models and an estimate for token-priced ones. Other providers' usage passes
 * through under a `provider:<name>` SKU at its gross charge: no Cloudflare allowance applies to
 * it. An event whose cost is still unknown carries no gross, so the allocator counts it as
 * unknown rather than $0.
 */
export function accountUsageFrom(events: readonly AiUsageEvent[], account: CloudflareAccountFacts, period: BillingPeriod): AccountUsageEvent[] {
  const rate = account.workersAiNeuronRate;
  return events.filter((event) => billingPeriodOf(event.occurredAt) === period).map((event) => {
    const known = !event.hasUnknownCost;
    const base = { accountId: account.accountId, product: EDUCATEOS_PRODUCT, costCenter: event.poolId, day: event.occurredAt.slice(0, 10) };
    const gross = known ? { grossUsdNano: event.chargedUsdNano } : {};
    if (event.model.provider !== "cloudflare") return { ...base, sku: `provider:${event.model.provider}`, ...gross };
    const neurons = known && usdNanoValue(rate.numeratorUsdNano) > 0n
      ? Number(usdNanoValue(event.chargedUsdNano) * BigInt(rate.denominator) / usdNanoValue(rate.numeratorUsdNano))
      : undefined;
    return { ...base, sku: WORKERS_AI_NEURONS_SKU, ...gross, ...(neurons === undefined ? {} : { neurons }) };
  });
}

/** The month's net estimate, or why there is none. */
export type NetEstimate =
  | {
    status: "estimated";
    /** The account the estimate is for. */
    accountId: CloudflareAccountId;
    /** Usage at list rates plus the account's fixed fees, before any allowance. */
    grossUsageUsdNano: UsdNano;
    /** The account's included usage applied (the daily Workers AI neurons). */
    freeAllowanceAppliedUsdNano: UsdNano;
    /** The account's monthly plan fee, which is in the gross and the net. */
    planFeeUsdNano: UsdNano;
    /** `gross - allowance`: what the invoice is estimated to say. */
    netEstimatedUsdNano: SignedUsdNano;
    /** The net shared among the pools that used the account. */
    allocations: { poolId: string; grossUsageUsdNano: UsdNano; netAllocatedUsdNano: SignedUsdNano }[];
    /** Requests whose cost is unknown, left out of every amount. */
    unknownCostRequests: number;
  }
  | { status: "unavailable"; reason: string };

/** The month's AI cost, with gross, net and safety spend kept apart. */
export interface AiCostSummary {
  /** The UTC month. */
  period: BillingPeriod;
  /** Settled requests this month. */
  requests: number;
  /** Settled model charges at list or gateway-estimated rates, before any allowance. */
  grossModelCostUsdNano: UsdNano;
  /** Reconciliation adjustments recorded against this month. */
  reconciliationAdjustmentUsdNano: SignedUsdNano;
  /** Held for requests still in progress. */
  heldUsdNano: UsdNano;
  /** Settled requests whose cost never came back, charged at their hold until reconciled. */
  unknownCostRequests: number;
  /** Settled safety (moderation) charges: part of the gross, paid only by the safety pool. */
  safetySpendUsdNano: UsdNano;
  /** The net estimated bill. */
  net: NetEstimate;
}

/** Why there is no net estimate when the district has no Cloudflare account facts. */
export const NO_ACCOUNT_FACTS_REASON =
  "No Cloudflare account is configured for this district, so the included allowances and plan fee cannot be applied. Only the gross model cost is shown.";

/**
 * Summarizes the month's cost. Gross model cost, safety spend and unknown-cost liabilities come
 * from the ledger's settled requests. With `account`, the month's usage is run through
 * `allocateCloudflareAccounts` (see {@link accountUsageFrom}) for the allowance applied, the
 * plan fee and the net estimate, shared out by pool. It sees only this district's usage: another
 * product in the same account shares the same allowance and fee, so for a shared account this
 * net is an upper bound on the district's share. No invoice is read.
 */
export function costSummary(input: {
  ledger: LedgerIndex;
  events: readonly AiUsageEvent[];
  period: BillingPeriod;
  account?: CloudflareAccountFacts;
}): AiCostSummary {
  const events = input.events.filter((event) => billingPeriodOf(event.occurredAt) === input.period);
  let gross = 0n;
  let safety = 0n;
  for (const event of events) {
    gross += usdNanoValue(event.chargedUsdNano);
    if (event.fundingPurpose === "safety") safety += usdNanoValue(event.chargedUsdNano);
  }
  let adjustments = 0n;
  for (const adjustment of input.ledger.adjustments) if (adjustment.period === input.period) adjustments += usdNanoValue(adjustment.deltaUsdNano);
  let held = 0n;
  for (const { reservation, settlement, voided } of input.ledger.requests) {
    if (reservation.period === input.period && settlement === undefined && voided === undefined) held += usdNanoValue(reservation.heldUsdNano);
  }
  return {
    period: input.period,
    requests: events.length,
    grossModelCostUsdNano: usdNano(gross),
    reconciliationAdjustmentUsdNano: signedUsdNano(adjustments),
    heldUsdNano: usdNano(held),
    unknownCostRequests: events.filter((event) => event.hasUnknownCost).length,
    safetySpendUsdNano: usdNano(safety),
    net: input.account === undefined ? { status: "unavailable", reason: NO_ACCOUNT_FACTS_REASON } : netEstimate(events, CloudflareAccountFacts.parse(input.account), input.period),
  };
}

function netEstimate(events: readonly AiUsageEvent[], account: CloudflareAccountFacts, period: BillingPeriod): NetEstimate {
  const report = allocateCloudflareAccounts({ month: period, accounts: [account], events: accountUsageFrom(events, account, period) });
  const allocated = report.accounts[0]!;
  const byPool = new Map<string, { gross: bigint; net: bigint }>();
  for (const row of allocated.months) {
    for (const share of row.allocations) {
      const entry = byPool.get(share.costCenter) ?? { gross: 0n, net: 0n };
      entry.gross += usdNanoValue(share.grossUsageUsdNano);
      entry.net += usdNanoValue(share.netAllocatedUsdNano);
      byPool.set(share.costCenter, entry);
    }
  }
  return {
    status: "estimated",
    accountId: account.accountId,
    grossUsageUsdNano: allocated.totals.grossUsageUsdNano,
    freeAllowanceAppliedUsdNano: allocated.totals.freeAllowanceAppliedUsdNano,
    planFeeUsdNano: account.workersPaidBaseFeeUsdNano,
    netEstimatedUsdNano: allocated.totals.netEstimatedUsdNano,
    allocations: [...byPool].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([poolId, { gross, net }]) => ({
      poolId,
      grossUsageUsdNano: usdNano(gross),
      netAllocatedUsdNano: signedUsdNano(net),
    })),
    unknownCostRequests: allocated.totals.unknownCostRequests,
  };
}

