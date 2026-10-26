import { Badge, Meter, Table, Text } from "@cloudflare/kumo";
import { useDirectoryNames } from "../app/useDirectoryNames.ts";
import { formatPercent, formatUsdNanoExact, PURPOSE_LABELS, scopeLabel, THRESHOLD_BADGES, type PoolStatus } from "./budgetFormat.ts";

/** A pool's threshold badge. */
export const ThresholdBadge = ({ pool }: { pool: PoolStatus }) => {
  const badge = THRESHOLD_BADGES[pool.threshold];
  return <Badge variant={badge.variant} appearance="dot">{badge.label}</Badge>;
};

/** How much of a pool's allocation is charged or held, as a meter. */
export const UtilizationMeter = ({ pool }: { pool: PoolStatus }) => (
  <Meter
    label={`${pool.name} used`}
    value={Math.min(pool.utilizationPercent ?? (pool.threshold === "exhausted" ? 100 : 0), 100)}
    customValue={formatPercent(pool.utilizationPercent)}
  />
);

/**
 * The class and personal pools this month: each one's allocation, what has been charged and is
 * held for requests still running, what remains, and how close it is to its allocation.
 */
export const FundingPoolTable = ({ pools }: { pools: readonly PoolStatus[] }) => {
  const names = useDirectoryNames();
  return (
    <section aria-labelledby="pools-heading" className="flex flex-col gap-2">
      <Text as="h3" variant="heading" id="pools-heading">Class and personal pools</Text>
      <Text variant="secondary">Charged is settled spend and bill corrections. Held is set aside for requests still running and returns to the pool if they cost less.</Text>
      {pools.length === 0 ? <Text>No class or personal pools are configured, so no AI requests are funded.</Text> : (
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Pool</Table.Head>
                <Table.Head>Funds</Table.Head>
                <Table.Head>Monthly allocation</Table.Head>
                <Table.Head>Charged</Table.Head>
                <Table.Head>Held</Table.Head>
                <Table.Head>Remaining</Table.Head>
                <Table.Head>Used</Table.Head>
                <Table.Head>Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {pools.map((pool) => (
                <Table.Row key={pool.poolId}>
                  <Table.Cell>{pool.name}</Table.Cell>
                  <Table.Cell>{PURPOSE_LABELS[pool.purpose]}: {scopeLabel(pool.scope, names)}</Table.Cell>
                  <Table.Cell>{formatUsdNanoExact(pool.monthlyAllocationUsdNano)}</Table.Cell>
                  <Table.Cell>{formatUsdNanoExact(pool.chargedUsdNano)}</Table.Cell>
                  <Table.Cell>{formatUsdNanoExact(pool.heldUsdNano)}</Table.Cell>
                  <Table.Cell>{formatUsdNanoExact(pool.remainingUsdNano)}</Table.Cell>
                  <Table.Cell className="min-w-40"><UtilizationMeter pool={pool} /></Table.Cell>
                  <Table.Cell><ThresholdBadge pool={pool} /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  );
};
