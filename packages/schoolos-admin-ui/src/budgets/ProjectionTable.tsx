import { Banner, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@schoolos/api-client";
import { formatPercent, formatUsdNanoExact } from "./budgetFormat.ts";

/** The month-end projection, as the district reports it. */
export type ProjectionReport = RouteResponse<"admin.aiProjection">;

/**
 * Each pool's projected month-end spend, with a warning for every pool projected to use more than
 * 80% of its allocation, and how the projection is made.
 */
export const ProjectionTable = ({ projection }: { projection: ProjectionReport }) => {
  const flagged = projection.pools.filter((pool) => pool.flagged);
  return (
    <section aria-labelledby="projection-heading" className="flex flex-col gap-2">
      <Text as="h3" variant="heading" id="projection-heading">Month-end projection</Text>
      <Text variant="secondary">
        Each pool's spend so far this month, charged and held, continued at the same daily rate to the end of the month ({projection.elapsedDays.toLocaleString("en-US", { maximumFractionDigits: 1 })} of {projection.monthDays} days so far, counting at least one). Breaks and quiet weeks make it run high.
      </Text>
      {flagged.map((pool) => (
        <Banner
          key={pool.poolId}
          variant="alert"
          icon={<Warning weight="fill" />}
          title={`${pool.name} is projected to use ${formatPercent(pool.projectedUtilizationPercent)} of its allocation`}
          description={`At this rate it spends ${formatUsdNanoExact(pool.projectedUsdNano)} of ${formatUsdNanoExact(pool.monthlyAllocationUsdNano)} this month, over the ${projection.warningPercent}% warning level. Requests are refused once a pool is used up.`}
        />
      ))}
      <div className="overflow-x-auto">
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Pool</Table.Head>
              <Table.Head>So far</Table.Head>
              <Table.Head>Projected for the month</Table.Head>
              <Table.Head>Of allocation</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {projection.pools.map((pool) => (
              <Table.Row key={pool.poolId}>
                <Table.Cell>{pool.name}</Table.Cell>
                <Table.Cell>{formatUsdNanoExact(pool.monthToDateUsdNano)}</Table.Cell>
                <Table.Cell>{formatUsdNanoExact(pool.projectedUsdNano)}</Table.Cell>
                <Table.Cell>{formatPercent(pool.projectedUtilizationPercent)}{pool.flagged ? ` (over ${projection.warningPercent}%)` : ""}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </section>
  );
};
