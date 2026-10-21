import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { AiProvider, AiRequestId, ModelRef, modelKey, sameModel } from "./model.ts";
import { signedUsdNano, usdNano, usdNanoFromDecimalUsd, usdNanoValue, type SignedUsdNano, type UsdNano } from "./money.ts";
import type { FundingPoolId } from "./pools.ts";
import { apportion } from "./apportion.ts";
import { ENTRY_SCHEMA_VERSION, billingPeriodOf, type AdjustmentBasis, type AdjustmentEntry, type LedgerIndex } from "./entries.ts";

/**
 * Identifies one reconciliation run, such as `2026-10-gateway`. Re-running a reconciliation under
 * the same ID appends nothing it already appended.
 */
export const ReconciliationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "expected a reconciliation ID");
/** A reconciliation identifier. */
export type ReconciliationId = z.infer<typeof ReconciliationId>;

/**
 * One row of a provider or AI Gateway cost export, in the format this package imports. The same
 * snake_case fields are used as CSV columns and as JSON object keys.
 *
 * | Field        | Meaning                                    | Mapping from an AI Gateway log export |
 * | ------------ | ------------------------------------------ | ------------------------------------- |
 * | `request_id` | The SchoolOS request ID, or empty/absent   | The `schoolos_request_id` key of the log's custom metadata, which the kernel seam sets on every request (`cf-aig-metadata`) |
 * | `date`       | UTC day the request was made, `YYYY-MM-DD` | The UTC date of the log's `created_at` |
 * | `provider`   | One of {@link AiProvider}                  | The log's `provider` (`workers-ai` maps to `cloudflare`) |
 * | `model`      | The model ID on the provider's API         | The log's `model` |
 * | `cost_usd`   | What was billed, in US dollars, as a decimal string with at most nine decimal places (one nanodollar) | The provider invoice line, or the log's `cost` |
 *
 * A provider invoice that has no request IDs leaves `request_id` empty; those rows reconcile by
 * model and day. Costs are strings so no float rounding happens before the ledger sees them.
 */
export const CostExportRow = z.strictObject({
  request_id: z.union([AiRequestId, z.literal("")]).optional(),
  date: z.iso.date(),
  provider: AiProvider,
  model: z.string().min(1).max(200),
  cost_usd: z.string().regex(/^\d{1,9}(\.\d{1,9})?$/, "expected a decimal dollar amount"),
});
/** A cost export row. */
export type CostExportRow = z.infer<typeof CostExportRow>;

/** The CSV columns, in order. The header row must be exactly these. */
export const COST_EXPORT_CSV_COLUMNS = ["request_id", "date", "provider", "model", "cost_usd"] as const;

/** The JSON form: a versioned document holding the rows. */
export const CostExportDocument = z.strictObject({
  format: z.literal("schoolos.ai-cost-export.v1"),
  rows: z.array(CostExportRow),
});
/** A cost export document. */
export type CostExportDocument = z.infer<typeof CostExportDocument>;

/** One billed line after import: costs in whole nanodollars, so sums are exact. */
export interface BilledCost {
  /** The matched request, when the export named one. */
  requestId?: AiRequestId;
  /** The UTC day. */
  day: string;
  /** The model billed. */
  model: ModelRef;
  /** What was billed. */
  costUsdNano: UsdNano;
}

function toBilledCost(row: CostExportRow): BilledCost {
  return {
    ...(row.request_id ? { requestId: row.request_id } : {}),
    day: row.date,
    model: ModelRef.parse({ provider: row.provider, modelId: row.model }),
    costUsdNano: usdNanoFromDecimalUsd(row.cost_usd),
  };
}

function rejected(where: string, error: z.ZodError): SchoolOsError {
  const detail = error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`).join("; ");
  return new SchoolOsError("validation-failed", `${where}: ${detail}`.slice(0, 1000));
}

/** Imports the JSON form. Any invalid row rejects the whole export, naming the row. */
export function parseCostExportJson(value: unknown): BilledCost[] {
  const parsed = CostExportDocument.safeParse(value);
  if (!parsed.success) throw rejected("cost export", parsed.error);
  return parsed.data.rows.map(toBilledCost);
}

/**
 * Imports the CSV form: a header row of exactly {@link COST_EXPORT_CSV_COLUMNS}, then one row per
 * billed line. Fields are unquoted, since none of them may contain a comma. Any invalid row
 * rejects the whole export, naming its line number.
 */
export function parseCostExportCsv(text: string): BilledCost[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines[0] !== COST_EXPORT_CSV_COLUMNS.join(",")) {
    throw new SchoolOsError("validation-failed", `cost export: expected the header ${COST_EXPORT_CSV_COLUMNS.join(",")}`);
  }
  return lines.slice(1).map((line, index) => {
    const fields = line.split(",");
    const where = `cost export line ${index + 2}`;
    if (fields.length !== COST_EXPORT_CSV_COLUMNS.length) {
      throw new SchoolOsError("validation-failed", `${where}: expected ${COST_EXPORT_CSV_COLUMNS.length} fields`);
    }
    const parsed = CostExportRow.safeParse(Object.fromEntries(COST_EXPORT_CSV_COLUMNS.map((column, i) => [column, fields[i]])));
    if (!parsed.success) throw rejected(where, parsed.error);
    return toBilledCost(parsed.data);
  });
}

/** One reconciled line: what the ledger charged against what was actually billed. */
export interface ReconciliationLine {
  /** The request or model-and-day this line covers. */
  basis: AdjustmentBasis;
  /** What the ledger settled from gateway estimates (and unknown-cost liabilities). */
  estimatedUsdNano: UsdNano;
  /** Adjustments earlier reconciliations already made for this basis. */
  priorAdjustmentUsdNano: SignedUsdNano;
  /** What the export says was billed. */
  actualUsdNano: UsdNano;
  /** `actualUsdNano - estimatedUsdNano`: how far the gateway estimate was off. */
  varianceUsdNano: SignedUsdNano;
  /** The correction this run makes: the variance not already adjusted. */
  adjustmentUsdNano: SignedUsdNano;
}

/** The outcome of reconciling one export against the ledger. */
export interface ReconciliationReport {
  /** The run. */
  reconciliationId: ReconciliationId;
  /** Every line that matched ledger usage. */
  lines: ReconciliationLine[];
  /**
   * Billed model-days with no ledger usage at all. They cannot be attributed to a pool, so they
   * are reported for an administrator and not adjusted.
   */
  unmatched: { model: ModelRef; day: string; actualUsdNano: UsdNano }[];
  /** Billed requests still holding a reservation. They are reconciled once they settle or void. */
  unsettledRequestIds: AiRequestId[];
  /** The adjustment entries this run appends. */
  adjustments: AdjustmentEntry[];
  /** Totals over `lines`. */
  totals: { estimatedUsdNano: UsdNano; actualUsdNano: UsdNano; varianceUsdNano: SignedUsdNano; adjustmentUsdNano: SignedUsdNano };
}

/**
 * Works out the adjustments that bring the ledger in line with a provider bill. Pure: it reads the
 * ledger and returns entries; `AiLedger.reconcile` appends them atomically.
 *
 * Rows naming a known request are matched to it: a settled request is compared with its settled
 * charge, and a voided one with nothing (the provider billed a request the gateway reported as
 * failed). Rows with no request ID, or one the ledger has never seen, are summed per model and
 * UTC day and compared with the settled requests of that model reserved that day that were not
 * matched by ID; the correction is apportioned across those requests' pools by their share.
 *
 * Each comparison counts earlier adjustments for the same basis, so re-importing a bill corrects
 * only what is still off. One export should cover a given day either by request or in aggregate,
 * not both.
 *
 * A settled request with an unknown cost was charged its hold as a liability. Matching it by ID
 * replaces that liability with the billed amount and clears its unknown flag, so its adjustment is
 * appended even when the two happen to agree (as a zero adjustment). Aggregate rows cannot clear
 * the flag, since they never say which request a cost belongs to.
 */
export function planReconciliation(
  ledger: LedgerIndex,
  reconciliationId: ReconciliationId,
  billed: readonly BilledCost[],
  recordedAt: string,
): ReconciliationReport {
  const report: ReconciliationReport = {
    reconciliationId,
    lines: [],
    unmatched: [],
    unsettledRequestIds: [],
    adjustments: [],
    totals: { estimatedUsdNano: "0", actualUsdNano: "0", varianceUsdNano: "0", adjustmentUsdNano: "0" },
  };
  const totals = { estimated: 0n, actual: 0n, variance: 0n, adjustment: 0n };
  const priorFor = (basisKey: string) => {
    let total = 0n;
    for (const adjustment of ledger.adjustments) {
      if (keyOfBasis(adjustment.basis) === basisKey) total += usdNanoValue(adjustment.deltaUsdNano);
    }
    return total;
  };
  /** Records one line and returns its adjustment. */
  const addLine = (basis: AdjustmentBasis, estimated: bigint, actual: bigint): bigint => {
    const prior = priorFor(keyOfBasis(basis));
    const adjustment = actual - estimated - prior;
    report.lines.push({
      basis,
      estimatedUsdNano: usdNano(estimated),
      priorAdjustmentUsdNano: signedUsdNano(prior),
      actualUsdNano: usdNano(actual),
      varianceUsdNano: signedUsdNano(actual - estimated),
      adjustmentUsdNano: signedUsdNano(adjustment),
    });
    totals.estimated += estimated;
    totals.actual += actual;
    totals.variance += actual - estimated;
    totals.adjustment += adjustment;
    return adjustment;
  };

  const byRequest = new Map<string, bigint>();
  const aggregate = new Map<string, { model: ModelRef; day: string; cost: bigint }>();
  for (const billedCost of billed) {
    const cost = usdNanoValue(billedCost.costUsdNano);
    if (billedCost.requestId !== undefined && ledger.request(billedCost.requestId) !== undefined) {
      byRequest.set(billedCost.requestId, (byRequest.get(billedCost.requestId) ?? 0n) + cost);
      continue;
    }
    const key = keyOfBasis({ kind: "aggregate", model: billedCost.model, day: billedCost.day });
    const group = aggregate.get(key) ?? { model: billedCost.model, day: billedCost.day, cost: 0n };
    group.cost += cost;
    aggregate.set(key, group);
  }

  for (const [requestId, cost] of byRequest) {
    const record = ledger.request(requestId)!;
    if (record.settlement === undefined && record.voided === undefined) {
      report.unsettledRequestIds.push(requestId);
      continue;
    }
    const basis: AdjustmentBasis = { kind: "request", requestId };
    const delta = addLine(basis, usdNanoValue(record.settlement?.chargedUsdNano ?? "0"), cost);
    if (delta === 0n && !ledger.hasOutstandingUnknownCost(requestId)) continue;
    const { reservation } = record;
    report.adjustments.push({
      type: "adjustment",
      entrySchemaVersion: ENTRY_SCHEMA_VERSION,
      adjustmentId: `${reconciliationId}:${keyOfBasis(basis)}:${reservation.poolId}`,
      reconciliationId,
      basis,
      poolId: reservation.poolId,
      model: reservation.model,
      period: reservation.period,
      attribution: { principalId: reservation.principalId, workspace: reservation.workspace },
      deltaUsdNano: signedUsdNano(delta),
      recordedAt,
    });
  }

  for (const group of aggregate.values()) {
    const poolCharges = new Map<FundingPoolId, { charged: bigint; requests: bigint }>();
    for (const { reservation, settlement } of ledger.requests) {
      if (settlement === undefined || byRequest.has(reservation.requestId)) continue;
      if (!sameModel(reservation.model, group.model) || reservation.reservedAt.slice(0, 10) !== group.day) continue;
      const share = poolCharges.get(reservation.poolId) ?? { charged: 0n, requests: 0n };
      share.charged += usdNanoValue(settlement.chargedUsdNano);
      share.requests += 1n;
      poolCharges.set(reservation.poolId, share);
    }
    if (poolCharges.size === 0) {
      report.unmatched.push({ model: group.model, day: group.day, actualUsdNano: usdNano(group.cost) });
      continue;
    }
    const shares = [...poolCharges].toSorted(([a], [b]) => a.localeCompare(b));
    const estimated = shares.reduce((sum, [, share]) => sum + share.charged, 0n);
    const basis: AdjustmentBasis = { kind: "aggregate", model: group.model, day: group.day };
    const delta = addLine(basis, estimated, group.cost);
    if (delta === 0n) continue;
    // Weigh pools by what they were charged; if every charge was zero, by how many requests they paid for.
    const weights = shares.map(([poolId, share]): [FundingPoolId, bigint] => [poolId, estimated > 0n ? share.charged : share.requests]);
    for (const [poolId, part] of apportion(delta, weights)) {
      if (part === 0n) continue;
      report.adjustments.push({
        type: "adjustment",
        entrySchemaVersion: ENTRY_SCHEMA_VERSION,
        adjustmentId: `${reconciliationId}:${keyOfBasis(basis)}:${poolId}`,
        reconciliationId,
        basis,
        poolId,
        model: group.model,
        period: billingPeriodOf(group.day),
        deltaUsdNano: signedUsdNano(part),
        recordedAt,
      });
    }
  }
  report.totals = {
    estimatedUsdNano: usdNano(totals.estimated),
    actualUsdNano: usdNano(totals.actual),
    varianceUsdNano: signedUsdNano(totals.variance),
    adjustmentUsdNano: signedUsdNano(totals.adjustment),
  };
  // Earlier adjustments count as prior, so an identical re-run plans none. A collision means the
  // same run ID was reused for a different bill, which must be imported under a new ID instead.
  const reused = report.adjustments.find((adjustment) => ledger.hasAdjustment(adjustment.adjustmentId));
  if (reused !== undefined) {
    throw new SchoolOsError("conflict", `reconciliation ${reconciliationId} already adjusted ${keyOfBasis(reused.basis)}; import a changed bill under a new reconciliation ID`);
  }
  return report;
}

function keyOfBasis(basis: AdjustmentBasis): string {
  return basis.kind === "request" ? `request:${basis.requestId}` : `aggregate:${modelKey(basis.model)}@${basis.day}`;
}
