import { Banner, LayerCard, Text } from "@cloudflare/kumo";
import { ShieldCheck, Warning } from "@phosphor-icons/react";
import { count } from "../app/labels.ts";
import { formatUsdNanoExact, type FundingReport } from "./budgetFormat.ts";
import { ThresholdBadge, UtilizationMeter } from "./FundingPoolTable.tsx";

/**
 * The protected safety reserve, apart from every other pool: what it holds and has spent on
 * moderation, and the recommended minimum for the district's size. Safety spend never comes out of
 * a student's or teacher's AI allowance, so it is shown on its own.
 */
export const SafetyReserveCard = ({ safety }: { safety: FundingReport["safety"] }) => {
  const { pool, population } = safety;
  const people = population.activeTeachers + population.aiEnabledStudents;
  return (
    <section aria-labelledby="safety-heading">
      <LayerCard className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck aria-hidden="true" size={20} />
          <Text as="h3" variant="heading" id="safety-heading">Safety reserve</Text>
          {pool !== undefined && <ThresholdBadge pool={pool} />}
        </div>
        <Text>
          Safety checks (moderation) are paid only from this reserve. Safety spend never comes from a student's or teacher's AI allowance, and no other AI use can draw on the reserve.
        </Text>
        {pool === undefined ? (
          <Banner variant="error" icon={<Warning weight="fill" />} title="No safety reserve is configured" description="Without one, safety checks cannot run, and student-facing AI that needs them stays off." />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
              <div><dt><Text variant="secondary">Monthly allocation</Text></dt><dd><Text>{formatUsdNanoExact(pool.monthlyAllocationUsdNano)}</Text></dd></div>
              <div><dt><Text variant="secondary">Safety spend</Text></dt><dd><Text>{formatUsdNanoExact(pool.chargedUsdNano)}</Text></dd></div>
              <div><dt><Text variant="secondary">Held</Text></dt><dd><Text>{formatUsdNanoExact(pool.heldUsdNano)}</Text></dd></div>
              <div><dt><Text variant="secondary">Reserve remaining</Text></dt><dd><Text>{formatUsdNanoExact(pool.remainingUsdNano)}</Text></dd></div>
            </dl>
            <UtilizationMeter pool={pool} />
          </>
        )}
        <Text>
          Recommended minimum: {formatUsdNanoExact(safety.recommendedMinimumUsdNano)} a month, the greater of $5.00 and $0.10 for each of the district's {count(population.activeTeachers, "active teacher")} and {count(population.aiEnabledStudents, "AI-enabled student")} ({count(people, "person", "people")}).
        </Text>
        {pool !== undefined && safety.belowRecommended && (
          <Banner variant="alert" icon={<Warning weight="fill" />} title="The safety reserve is below the recommended minimum" description="If the reserve runs out, AI that needs safety checks is paused until next month." />
        )}
      </LayerCard>
    </section>
  );
};
