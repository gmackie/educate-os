import { Text } from "@cloudflare/kumo";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { AllocationForm } from "./AllocationForm.tsx";
import { CostSummary } from "./CostSummary.tsx";
import { FundingPoolTable } from "./FundingPoolTable.tsx";
import { ProjectionTable } from "./ProjectionTable.tsx";
import { SafetyReserveCard } from "./SafetyReserveCard.tsx";

/**
 * The district's AI budgets this month: the cost summary (gross, free allowance, net, safety,
 * remaining), the class and personal pools, the protected safety reserve, the month-end projection,
 * and the monthly allocations. Everything is a total or a count; no one's requests are shown.
 */
export const AiBudgetsPage = () => {
  const funding = useLoad("ai-funding", (c) => c.call("admin.aiFunding"));
  const cost = useLoad("ai-cost", (c) => c.call("admin.aiCostSummary"));
  const projection = useLoad("ai-projection", (c) => c.call("admin.aiProjection"));
  const reload = () => {
    funding.reload();
    cost.reload();
    projection.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">AI budgets</Text>
      <Text variant="secondary">How much the district has set aside for AI this month, what it has cost, and what is left. What people asked or were answered is never shown here.</Text>
      <LoadState loaded={funding} what="the AI budgets" onRetry={funding.reload}>
        {({ report, revision }) => (
          <div className="flex flex-col gap-8">
            <LoadState loaded={cost} what="this month's AI cost" onRetry={cost.reload}>
              {(summary) => <CostSummary cost={summary} funding={report} />}
            </LoadState>
            <FundingPoolTable pools={report.pools} />
            <SafetyReserveCard safety={report.safety} />
            <LoadState loaded={projection} what="the month-end projection" onRetry={projection.reload}>
              {(p) => <ProjectionTable projection={p} />}
            </LoadState>
            <AllocationForm key={revision?.id ?? "configured"} report={report} revisionId={revision?.id} onSaved={reload} />
          </div>
        )}
      </LoadState>
    </div>
  );
};
