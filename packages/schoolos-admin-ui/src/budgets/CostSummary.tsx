import type { ReactNode } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@schoolos/api-client";
import { count } from "../app/labels.ts";
import { formatUsdNanoExact, type FundingReport } from "./budgetFormat.ts";

/** This month's cost, as the district reports it. */
export type CostSummaryReport = RouteResponse<"admin.aiCostSummary">;

const Figure = ({ term, value, children }: { term: string; value: string; children: ReactNode }) => (
  <LayerCard className="flex flex-col gap-1 p-4">
    <dt><Text variant="secondary">{term}</Text></dt>
    <dd className="flex flex-col gap-1">
      <Text variant="heading" size="lg">{value}</Text>
      <Text variant="secondary" size="sm">{children}</Text>
    </dd>
  </LayerCard>
);

const sum = (amounts: readonly string[]) => amounts.reduce((total, amount) => total + BigInt(amount), 0n).toString();

/**
 * This month's AI cost, with each kind of amount named and explained on its own: the gross model
 * cost at list prices, the free allowance and the net bill they lead to, the safety reserve, and
 * what remains in the pools. These are different amounts that are easy to confuse, so none is
 * folded into another.
 */
export const CostSummary = ({ cost, funding }: { cost: CostSummaryReport; funding: FundingReport }) => {
  const { net } = cost;
  const remaining = sum(funding.pools.map((pool) => pool.remainingUsdNano));
  return (
    <section aria-labelledby="cost-heading" className="flex flex-col gap-2">
      <Text as="h3" variant="heading" id="cost-heading">This month's cost ({cost.period})</Text>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Figure term="Gross model cost" value={formatUsdNanoExact(cost.grossModelCostUsdNano)}>
          What {count(cost.requests, "AI request")} cost at list prices, before any free allowance. Safety checks are included.
        </Figure>
        <Figure term="Free allowance applied" value={net.status === "estimated" ? formatUsdNanoExact(net.freeAllowanceAppliedUsdNano) : "Not available"}>
          {net.status === "estimated"
            ? "Usage the district's Cloudflare account includes at no charge, applied once for the whole account."
            : net.reason}
        </Figure>
        <Figure term="Net estimated bill" value={net.status === "estimated" ? formatUsdNanoExact(net.netEstimatedUsdNano) : "Not available"}>
          {net.status === "estimated"
            ? `An estimate of what the account will be invoiced: gross usage less the free allowance, including the ${formatUsdNanoExact(net.planFeeUsdNano)} monthly plan fee. It is not an invoice.`
            : "Shown once the district's Cloudflare account is configured."}
        </Figure>
        <Figure term="Safety reserve spend" value={formatUsdNanoExact(cost.safetySpendUsdNano)}>
          {funding.safety.pool === undefined
            ? "There is no safety reserve."
            : `Paid from the safety reserve only, which has ${formatUsdNanoExact(funding.safety.pool.remainingUsdNano)} remaining.`}
        </Figure>
        <Figure term="Remaining in class and personal pools" value={formatUsdNanoExact(remaining)}>
          What is left this month across the pools that fund AI for classes and personal spaces, after charges and holds.
        </Figure>
        <Figure term="Unreconciled requests" value={cost.unknownCostRequests.toLocaleString("en-US")}>
          Requests whose cost the provider has not reported yet. Each is counted at the most it could cost until the bill is reconciled. {formatUsdNanoExact(cost.heldUsdNano)} is held for requests still running.
        </Figure>
      </dl>
    </section>
  );
};
