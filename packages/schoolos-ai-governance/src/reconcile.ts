import { z } from "zod";
import { SchoolOsError } from "@schoolos/contracts";
import { AiProvider, AiRequestId, ModelRef, modelKey, sameModel } from "./model.ts";
import type { FundingPoolId } from "./pools.ts";
import { billingPeriodOf, type AdjustmentBasis, type AdjustmentEntry, type LedgerIndex } from "./entries.ts";

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
 * | `cost_usd`   | What was billed, in US dollars, as a decimal string with at most six decimal places | The provider invoice line, or the log's `cost` |
 *
 * A provider invoice that has no request IDs leaves `request_id` empty; those rows reconcile by
 * model and day. Costs are strings so no float rounding happens before the ledger sees them.
 */
export const CostExportRow = z.strictObject({
  request_id: z.union([AiRequestId, z.literal("")]).optional(),
  date: z.iso.date(),
  provider: AiProvider,
  model: z.string().min(1).max(200),
  cost_usd: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, "expected a decimal dollar amount"),
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

/** One billed line after import: costs in whole micro-dollars, so sums are exact. */
export interface BilledCost {
  /** The matched request, when the export named one. */
  requestId?: AiRequestId;
  /** The UTC day. */
  day: string;
  /** The model billed. */
  model: ModelRef;
  /** The cost in millionths of a US dollar. */
  costMicroUsd: number;
}

function toBilledCost(row: CostExportRow): BilledCost {
  const [whole, fraction = ""] = row.cost_usd.split(".");
  return {
    ...(row.request_id ? { requestId: row.request_id } : {}),
    day: row.date,
    model: ModelRef.parse({ provider: row.provider, modelId: row.model }),
    costMicroUsd: Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0")),
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

/** Whole cents from micro-dollars, rounding half up. */
function centsOf(microUsd: number): number {
  return Math.floor((microUsd + 5_000) / 10_000);
}

/** One reconciled line: what the ledger charged against what was actually billed. */
export interface ReconciliationLine {
  /** The request or model-and-day this line covers. */
  basis: AdjustmentBasis;
  /** What the ledger settled from gateway estimates. */
  estimatedCents: number;
  /** Adjustments earlier reconciliations already made for this basis. */
  priorAdjustmentCents: number;
  /** What the export says was billed. */
  actualCents: number;
  /** `actualCents - estimatedCents`: how far the gateway estimate was off. */
  varianceCents: number;
  /** The correction this run makes: the variance not already adjusted. */
  adjustmentCents: number;
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
  unmatched: { model: ModelRef; day: string; actualCents: number }[];
  /** Billed requests still holding a reservation. They are reconciled once they settle or void. */
  unsettledRequestIds: AiRequestId[];
  /** The adjustment entries this run appends. */
  adjustments: AdjustmentEntry[];
  /** Totals over `lines`. */
  totals: { estimatedCents: number; actualCents: number; varianceCents: number; adjustmentCents: number };
}

/**
 * Splits `amount` across weights in proportion, by largest remainder, so the parts sum exactly.
 * Ties go to the earlier key, which callers keep in a stable order.
 */
function apportion<K>(amount: number, weights: [K, number][]): [K, number][] {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  const magnitude = Math.abs(amount);
  const shares = weights.map(([key, weight], index) => {
    const exact = (magnitude * weight) / total;
    return { key, index, whole: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = magnitude - shares.reduce((sum, share) => sum + share.whole, 0);
  for (const share of shares.toSorted((a, b) => b.remainder - a.remainder || a.index - b.index)) {
    if (left === 0) break;
    share.whole += 1;
    left -= 1;
  }
  return shares.map((share) => [share.key, Math.sign(amount) * share.whole]);
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
    totals: { estimatedCents: 0, actualCents: 0, varianceCents: 0, adjustmentCents: 0 },
  };
  const priorFor = (basisKey: string) => {
    let total = 0;
    for (const adjustment of ledger.adjustments) {
      if (keyOfBasis(adjustment.basis) === basisKey) total += adjustment.deltaCents;
    }
    return total;
  };
  const addLine = (basis: AdjustmentBasis, estimatedCents: number, actualCents: number) => {
    const priorAdjustmentCents = priorFor(keyOfBasis(basis));
    const line: ReconciliationLine = {
      basis,
      estimatedCents,
      priorAdjustmentCents,
      actualCents,
      varianceCents: actualCents - estimatedCents,
      adjustmentCents: actualCents - estimatedCents - priorAdjustmentCents,
    };
    report.lines.push(line);
    report.totals.estimatedCents += line.estimatedCents;
    report.totals.actualCents += line.actualCents;
    report.totals.varianceCents += line.varianceCents;
    report.totals.adjustmentCents += line.adjustmentCents;
    return line;
  };

  const byRequest = new Map<string, number>();
  const aggregate = new Map<string, { model: ModelRef; day: string; costMicroUsd: number }>();
  for (const cost of billed) {
    if (cost.requestId !== undefined && ledger.request(cost.requestId) !== undefined) {
      byRequest.set(cost.requestId, (byRequest.get(cost.requestId) ?? 0) + cost.costMicroUsd);
      continue;
    }
    const key = keyOfBasis({ kind: "aggregate", model: cost.model, day: cost.day });
    const group = aggregate.get(key) ?? { model: cost.model, day: cost.day, costMicroUsd: 0 };
    group.costMicroUsd += cost.costMicroUsd;
    aggregate.set(key, group);
  }

  for (const [requestId, costMicroUsd] of byRequest) {
    const record = ledger.request(requestId)!;
    if (record.settlement === undefined && record.voided === undefined) {
      report.unsettledRequestIds.push(requestId);
      continue;
    }
    const basis: AdjustmentBasis = { kind: "request", requestId };
    const line = addLine(basis, record.settlement?.actualCents ?? 0, centsOf(costMicroUsd));
    if (line.adjustmentCents === 0) continue;
    const { reservation } = record;
    report.adjustments.push({
      type: "adjustment",
      adjustmentId: `${reconciliationId}:${keyOfBasis(basis)}:${reservation.poolId}`,
      reconciliationId,
      basis,
      poolId: reservation.poolId,
      model: reservation.model,
      period: reservation.period,
      attribution: { principalId: reservation.principalId, workspace: reservation.workspace },
      deltaCents: line.adjustmentCents,
      recordedAt,
    });
  }

  for (const group of aggregate.values()) {
    const actualCents = centsOf(group.costMicroUsd);
    const poolCents = new Map<FundingPoolId, { cents: number; requests: number }>();
    for (const { reservation, settlement } of ledger.requests) {
      if (settlement === undefined || byRequest.has(reservation.requestId)) continue;
      if (!sameModel(reservation.model, group.model) || reservation.reservedAt.slice(0, 10) !== group.day) continue;
      const share = poolCents.get(reservation.poolId) ?? { cents: 0, requests: 0 };
      share.cents += settlement.actualCents;
      share.requests += 1;
      poolCents.set(reservation.poolId, share);
    }
    if (poolCents.size === 0) {
      report.unmatched.push({ model: group.model, day: group.day, actualCents });
      continue;
    }
    const shares = [...poolCents].toSorted(([a], [b]) => a.localeCompare(b));
    const estimatedCents = shares.reduce((sum, [, share]) => sum + share.cents, 0);
    const basis: AdjustmentBasis = { kind: "aggregate", model: group.model, day: group.day };
    const line = addLine(basis, estimatedCents, actualCents);
    if (line.adjustmentCents === 0) continue;
    // Weigh pools by what they were charged; if every charge was zero, by how many requests they paid for.
    const weights = shares.map(([poolId, share]): [FundingPoolId, number] => [poolId, estimatedCents > 0 ? share.cents : share.requests]);
    for (const [poolId, deltaCents] of apportion(line.adjustmentCents, weights)) {
      if (deltaCents === 0) continue;
      report.adjustments.push({
        type: "adjustment",
        adjustmentId: `${reconciliationId}:${keyOfBasis(basis)}:${poolId}`,
        reconciliationId,
        basis,
        poolId,
        model: group.model,
        period: billingPeriodOf(group.day),
        deltaCents,
        recordedAt,
      });
    }
  }
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
