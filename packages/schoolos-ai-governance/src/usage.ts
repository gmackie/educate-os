import { z } from "zod";
import { DistrictId, PrincipalId } from "@schoolos/contracts";
import { AiRequestId, AiWorkspaceContext, Cents, ModelRef, modelKey } from "./model.ts";
import { FundingPoolId } from "./pools.ts";
import type { AdjustmentEntry, LedgerIndex } from "./entries.ts";

/**
 * The attribution record for one settled model request: who made it, from which offering (or a
 * personal workspace), which pool paid, which model ran, the tokens it used and what it cost.
 *
 * It never carries a prompt, response, tool argument or message. Strict parsing rejects any field
 * not listed here, and a test holds the field list to identifiers, counts and cents.
 */
export const AiUsageEvent = z.strictObject({
  requestId: AiRequestId,
  districtId: DistrictId,
  principalId: PrincipalId,
  workspace: AiWorkspaceContext,
  poolId: FundingPoolId,
  model: ModelRef,
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  /** The settled charge: the gateway's estimate of the actual cost, before reconciliation. */
  cents: Cents,
  occurredAt: z.iso.datetime(),
});
/** An AI usage event. */
export type AiUsageEvent = z.infer<typeof AiUsageEvent>;

/** One usage event per settled request, in reservation order. Voided and still-held requests have none. */
export function usageEventsFrom(ledger: LedgerIndex): AiUsageEvent[] {
  const events: AiUsageEvent[] = [];
  for (const { reservation, settlement } of ledger.requests) {
    if (settlement === undefined) continue;
    events.push({
      requestId: reservation.requestId,
      districtId: reservation.districtId,
      principalId: reservation.principalId,
      workspace: reservation.workspace,
      poolId: reservation.poolId,
      model: reservation.model,
      ...settlement.usage,
      cents: settlement.actualCents,
      occurredAt: reservation.reservedAt,
    });
  }
  return events;
}

/** Usage and cost totals for one report row. */
export interface UsageTotals {
  /** Settled requests. */
  requests: number;
  /** Input tokens. */
  inputTokens: number;
  /** Output tokens. */
  outputTokens: number;
  /** Cache-read tokens. */
  cacheReadTokens: number;
  /** Cache-write tokens. */
  cacheWriteTokens: number;
  /** Settled charges, from the gateway's estimates. */
  usageCents: number;
  /** Reconciliation adjustments attributed to this row. */
  adjustmentCents: number;
  /** `usageCents + adjustmentCents`: what this row actually cost. */
  totalCents: number;
}

/**
 * Aggregate AI usage for a district (the U03 dashboard's source). Every settled cent and adjustment
 * lands in exactly one row of each breakdown, so each breakdown sums to `district`:
 *
 * - `byPrincipal` plus `unattributed` (bill corrections reconciled by day rather than by request),
 * - `byOffering` plus `personal` plus `unattributed`,
 * - `byPool`, and `byModel` (keyed `provider/modelId`), with nothing unattributed.
 */
export interface UsageReport {
  /** The district total. */
  district: UsageTotals;
  /** Per principal. */
  byPrincipal: Record<string, UsageTotals>;
  /** Per course offering. */
  byOffering: Record<string, UsageTotals>;
  /** Personal-workspace use. */
  personal: UsageTotals;
  /** Per funding pool. */
  byPool: Record<string, UsageTotals>;
  /** Per model. */
  byModel: Record<string, UsageTotals>;
  /** Adjustments that correct a day's aggregate rather than one principal's request. */
  unattributed: UsageTotals;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usageCents: 0,
    adjustmentCents: 0,
    totalCents: 0,
  };
}

function row(rows: Record<string, UsageTotals>, key: string): UsageTotals {
  rows[key] ??= emptyTotals();
  return rows[key];
}

function addEvent(totals: UsageTotals, event: AiUsageEvent): void {
  totals.requests += 1;
  totals.inputTokens += event.inputTokens;
  totals.outputTokens += event.outputTokens;
  totals.cacheReadTokens += event.cacheReadTokens;
  totals.cacheWriteTokens += event.cacheWriteTokens;
  totals.usageCents += event.cents;
  totals.totalCents += event.cents;
}

function addAdjustment(totals: UsageTotals, adjustment: AdjustmentEntry): void {
  totals.adjustmentCents += adjustment.deltaCents;
  totals.totalCents += adjustment.deltaCents;
}

/** Builds a {@link UsageReport} from usage events and reconciliation adjustments. */
export function usageReport(events: Iterable<AiUsageEvent>, adjustments: Iterable<AdjustmentEntry>): UsageReport {
  const report: UsageReport = {
    district: emptyTotals(),
    byPrincipal: {},
    byOffering: {},
    personal: emptyTotals(),
    byPool: {},
    byModel: {},
    unattributed: emptyTotals(),
  };
  for (const event of events) {
    addEvent(report.district, event);
    addEvent(row(report.byPrincipal, event.principalId), event);
    addEvent(event.workspace.kind === "course" ? row(report.byOffering, event.workspace.offeringId) : report.personal, event);
    addEvent(row(report.byPool, event.poolId), event);
    addEvent(row(report.byModel, modelKey(event.model)), event);
  }
  for (const adjustment of adjustments) {
    addAdjustment(report.district, adjustment);
    addAdjustment(row(report.byPool, adjustment.poolId), adjustment);
    addAdjustment(row(report.byModel, modelKey(adjustment.model)), adjustment);
    const attribution = adjustment.attribution;
    if (attribution === undefined) {
      addAdjustment(report.unattributed, adjustment);
      continue;
    }
    addAdjustment(row(report.byPrincipal, attribution.principalId), adjustment);
    const workspace = attribution.workspace;
    addAdjustment(workspace.kind === "course" ? row(report.byOffering, workspace.offeringId) : report.personal, adjustment);
  }
  return report;
}
