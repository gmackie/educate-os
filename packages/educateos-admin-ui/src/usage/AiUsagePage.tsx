import { Meter, Table, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { ceilUsdNanoToCents } from "@educateos/contracts";
import { count } from "../app/labels.ts";
import { useDirectoryNames } from "../app/useDirectoryNames.ts";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import type { DistrictConfigState } from "../app/useDistrictConfig.ts";
import { formatCents, formatUsdNano } from "../policies/policySettings.ts";

type UsageReport = RouteResponse<"admin.aiUsage">;
type UsageTotals = UsageReport["district"];

const UsageTable = ({ caption, label, rows }: { caption: string; label: string; rows: [string, UsageTotals][] }) => (
  <section aria-label={caption} className="flex flex-col gap-2">
    <Text as="h3" variant="heading">{caption}</Text>
    {rows.length === 0 ? <Text variant="secondary">No AI use recorded.</Text> : (
      <div className="overflow-x-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>{label}</Table.Head>
              <Table.Head>Requests</Table.Head>
              <Table.Head>Tokens in</Table.Head>
              <Table.Head>Tokens out</Table.Head>
              <Table.Head>Cost</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map(([key, totals]) => (
              <Table.Row key={key}>
                <Table.Cell>{key}</Table.Cell>
                <Table.Cell>{totals.requests.toLocaleString("en-US")}</Table.Cell>
                <Table.Cell>{totals.inputTokens.toLocaleString("en-US")}</Table.Cell>
                <Table.Cell>{totals.outputTokens.toLocaleString("en-US")}</Table.Cell>
                <Table.Cell>{formatUsdNano(totals.totalUsdNano)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    )}
  </section>
);

/** How many people's recorded spend reached, or came near, the per-person cap. Counts only. */
export function capStatus(report: UsageReport, capCents: number): { atCap: number; nearCap: number; people: number } {
  const spends = Object.values(report.byPrincipal).map((t) => ceilUsdNanoToCents(t.totalUsdNano));
  return {
    atCap: spends.filter((s) => s >= capCents).length,
    nearCap: spends.filter((s) => s < capCents && s >= capCents * 0.8).length,
    people: spends.length,
  };
}

/**
 * AI usage by class, funding pool and model, with the per-person cap status. Per-person figures are
 * only ever counted, and no prompt or response is shown.
 */
export const AiUsagePage = ({ state }: { state: DistrictConfigState }) => {
  const usage = useLoad("usage", (c) => c.call("admin.aiUsage"));
  const names = useDirectoryNames();
  const cap = state.config.status === "ready"
    ? state.config.data.head?.desired.policies.aiMonthlyCapCentsPerPrincipal ?? state.config.data.districtPolicy.aiMonthlyCapCentsPerPrincipal
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">AI usage</Text>
      <Text variant="secondary">Totals of recorded AI use. What people asked or were answered is never shown here.</Text>
      <LoadState loaded={usage} what="AI usage" onRetry={usage.reload}>
        {(report) => {
          const status = cap === undefined ? undefined : capStatus(report, cap);
          return (
            <div className="flex flex-col gap-8">
              <section aria-labelledby="usage-total" className="flex flex-col gap-2">
                <Text as="h3" variant="heading" id="usage-total">District total</Text>
                <Text>{count(report.district.requests, "request")}, {formatUsdNano(report.district.totalUsdNano)} in total, of which {formatUsdNano(report.personal.totalUsdNano)} in personal spaces.</Text>
              </section>
              {status !== undefined && cap !== undefined && (
                <section aria-labelledby="cap-status" className="flex max-w-lg flex-col gap-2">
                  <Text as="h3" variant="heading" id="cap-status">Cap status</Text>
                  <Text>The cap is {formatCents(cap)} per person per month. Of {count(status.people, "person", "people")} who used AI, {status.atCap} reached it and {status.nearCap} are within 20% of it.</Text>
                  <Meter label="People who reached the cap" value={status.atCap} max={Math.max(status.people, 1)} customValue={`${status.atCap} of ${status.people}`} />
                </section>
              )}
              <UsageTable caption="By class" label="Class" rows={Object.entries(report.byOffering).map(([id, t]) => [names.offering(id), t])} />
              <UsageTable caption="By funding pool" label="Pool" rows={Object.entries(report.byPool)} />
              <UsageTable caption="By model" label="Model" rows={Object.entries(report.byModel)} />
            </div>
          );
        }}
      </LoadState>
    </div>
  );
};
