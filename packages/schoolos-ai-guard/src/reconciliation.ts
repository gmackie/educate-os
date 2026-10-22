// The guard's nightly reconciliation (SCHO-134), run by its Cron Trigger: settle unknown-cost
// requests from their AI Gateway logs, and record the month's allocation snapshot (SCHO-116).
// Both steps are idempotent, so a retried or repeated run changes nothing it already changed.
// Importing the provider's or Cloudflare's bill is out of scope.

import { billingPeriodOf, ModelRef, usdNanoFromGatewayCost, usdNanoValue, usdNano, type BilledCost } from "@schoolos/ai-governance";
import { createLogger } from "@gadgets/observability/logger";
import type { GatewayLogSource } from "./gateway-logs.ts";
import type { DistrictAiLedger } from "./ledger-object.ts";

type ReconciliationLogFields = {
  reconciliationId: string;
  period: string;
  outstanding: number;
  billed: number;
  adjustments: number;
  pending: number;
  failed: number;
  written: boolean;
  outcome: string;
};

const logger = createLogger<ReconciliationLogFields>({ component: "schoolos.ai-guard.reconciliation" });

/** The most unknown-cost requests one run looks up, which bounds its subrequests. */
export const MAX_LOOKUPS_PER_RUN = 200;

/** What one run did. Counts and IDs only. */
export interface ReconciliationRun {
  /** The run's reconciliation ID: one per UTC day, so a re-run that day is the same run. */
  reconciliationId: string;
  /** Requests whose cost was still unknown, up to {@link MAX_LOOKUPS_PER_RUN}. */
  outstanding: number;
  /** Of those, how many the gateway logs priced. */
  billed: number;
  /** Adjustment entries appended. */
  adjustments: number;
  /** Requests whose logs have no cost yet; a later run tries again. */
  pending: number;
  /** Requests whose lookup failed. */
  failed: number;
  /** The allocation snapshot recorded. */
  snapshot: { period: string; asOf: string; written: boolean };
}

/** What a run needs: the district ledger, the gateway's logs (if readable), and the run's instant. */
export interface ReconciliationDependencies {
  /** The district ledger. */
  ledger: DurableObjectStub<DistrictAiLedger>;
  /** The AI Gateway's logs, or `null` when the deployment cannot read them. */
  gatewayLogs: GatewayLogSource | null;
  /** When the run was scheduled. */
  scheduledTime: Date;
}

const DAY_MS = 86_400_000;

/**
 * One nightly run:
 *
 * 1. With gateway logs, every outstanding unknown-cost request whose attempts all name a log is
 *    looked up; those whose logs all report a cost are reconciled by request ID under
 *    `gateway-logs-<day>`, which replaces the hold charged as a liability with the billed cost and
 *    clears the request's unknown flag (an adjustment entry; the settlement is never rewritten).
 * 2. The month of the day just ended gets its allocation snapshot as of that day's end, so the
 *    run after the last day of a month closes that month.
 */
export async function runReconciliation(dependencies: ReconciliationDependencies): Promise<ReconciliationRun> {
  const { ledger, gatewayLogs, scheduledTime } = dependencies;
  const reconciliationId = `gateway-logs-${scheduledTime.toISOString().slice(0, 10)}`;
  const log = logger.with({ reconciliationId });
  const run = { reconciliationId, outstanding: 0, billed: 0, adjustments: 0, pending: 0, failed: 0 };

  if (gatewayLogs !== null) {
    const outstanding = await ledger.outstandingUnknownCosts(MAX_LOOKUPS_PER_RUN);
    run.outstanding = outstanding.length;
    const billed: BilledCost[] = [];
    for (const request of outstanding) {
      try {
        const logs = await Promise.all(request.gatewayLogIds.map((id) => gatewayLogs.log(id)));
        const costs = logs.map((entry) => entry?.cost);
        if (costs.some((cost) => cost === undefined || cost === null)) {
          run.pending++;
          continue;
        }
        const total = costs.reduce((sum, cost) => sum + usdNanoValue(usdNanoFromGatewayCost(cost!)), 0n);
        billed.push({ requestId: request.requestId, day: request.day, model: ModelRef.parse(request.model), costUsdNano: usdNano(total) });
      } catch {
        run.failed++;
      }
    }
    run.billed = billed.length;
    if (billed.length > 0) {
      const result = await ledger.reconcile(reconciliationId, billed);
      if (result.outcome === "reconciled") run.adjustments = result.adjustments;
      else log.error("gateway log reconciliation conflicts with an earlier run", { event: "ai_guard.reconcile.conflict", outcome: result.outcome });
    }
  }

  const closedDay = new Date(scheduledTime.getTime() - DAY_MS).toISOString().slice(0, 10);
  const asOf = `${closedDay}T23:59:59.999Z`;
  const period = billingPeriodOf(asOf);
  const { written } = await ledger.recordAllocationSnapshot(period, asOf);
  log.info("nightly reconciliation ran", { event: "ai_guard.reconcile.ran", ...run, reconciliationId, period, written });
  return { ...run, snapshot: { period, asOf, written } };
}
