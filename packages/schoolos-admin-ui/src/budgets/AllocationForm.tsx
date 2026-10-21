import { useState } from "react";
import { Banner, Button, Input, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { errorMessage } from "../app/useLoad.ts";
import { formatCents, usdNanoToCents } from "../policies/policySettings.ts";
import {
  centsToDollarsInput,
  parseDollarsToCents,
  PURPOSE_LABELS,
  usdNanoToWholeCents,
  type FundingReport,
  type PoolStatus,
} from "./budgetFormat.ts";

interface AllocationFormProps {
  /** The funding report the form edits. Remount with a `key` when its revision changes. */
  report: FundingReport;
  /** The allocation revision the report reflects, which the change is made over. */
  revisionId: string | undefined;
  /** Called once the district has recorded a change. */
  onSaved: () => void;
}

/** One pool whose allocation the form changes. */
interface AllocationChange {
  pool: PoolStatus;
  fromCents: number;
  toCents: number;
}

/**
 * Edits the monthly allocation of every pool, the safety reserve included, in dollars and cents.
 * Each amount is checked as it is typed, the class and personal pools are checked against the
 * district's overall cap, and a safety reserve below its recommended minimum is pointed out. The
 * changes are listed for confirmation before the district records them.
 */
export const AllocationForm = ({ report, revisionId, onSaved }: AllocationFormProps) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const pools = [...report.pools, ...(report.safety.pool === undefined ? [] : [report.safety.pool])];
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(pools.map((pool) => [pool.poolId, centsToDollarsInput(usdNanoToWholeCents(pool.monthlyAllocationUsdNano))])));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const parsed = pools.map((pool) => ({ pool, cents: parseDollarsToCents(drafts[pool.poolId] ?? "") }));
  const valid = parsed.every((entry) => entry.cents !== undefined);
  const changes: AllocationChange[] = parsed.flatMap(({ pool, cents }) => {
    const fromCents = usdNanoToWholeCents(pool.monthlyAllocationUsdNano);
    return cents === undefined || cents === fromCents ? [] : [{ pool, fromCents, toCents: cents }];
  });
  const generativeCents = parsed.filter((entry) => entry.pool.purpose !== "safety").reduce((total, entry) => total + (entry.cents ?? 0), 0);
  const capCents = report.districtCapUsdNano === undefined ? undefined : usdNanoToWholeCents(report.districtCapUsdNano);
  const overCap = capCents !== undefined && generativeCents > capCents;
  const safetyCents = report.safety.pool === undefined ? undefined : parsed.find((entry) => entry.pool.purpose === "safety")?.cents;
  const recommendedCents = usdNanoToCents(report.safety.recommendedMinimumUsdNano);
  const safetyBelowRecommended = safetyCents !== undefined && safetyCents < recommendedCents;

  const save = async () => {
    setConfirming(false);
    setSaving(true);
    setError(undefined);
    try {
      const result = await client.call("admin.updateFundingPools", {
        body: {
          allocations: changes.map((change) => ({ poolId: change.pool.poolId, monthlyAllocationCents: change.toCents })),
          ...(revisionId === undefined ? {} : { expectedRevisionId: revisionId }),
        },
      });
      announce(["The funding allocations were saved.", ...result.warnings].join(" "));
      onSaved();
    } catch (e) {
      const message = errorMessage(e);
      setError(message);
      announce(`The funding allocations were not saved. ${message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="allocations-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="allocations-heading">Monthly allocations</Text>
      <Text variant="secondary">
        Set how much each pool may spend each month. A change applies to the current month at once.
        {capCents === undefined ? "" : ` The class and personal pools together may not exceed the district's cap of ${formatCents(capCents)}.`}
      </Text>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="The allocations were not saved" description={error} />}
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (valid && !overCap && changes.length > 0) setConfirming(true); }}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {parsed.map(({ pool, cents }) => (
            <Input
              key={pool.poolId}
              label={`${pool.name} (US dollars a month)`}
              description={`${PURPOSE_LABELS[pool.purpose]}. Now ${formatCents(usdNanoToWholeCents(pool.monthlyAllocationUsdNano))}.`}
              inputMode="decimal"
              value={drafts[pool.poolId] ?? ""}
              onChange={(event) => setDrafts({ ...drafts, [pool.poolId]: event.target.value })}
              error={cents === undefined ? "Enter an amount from 0.00 to 1,000,000.00, with at most two decimal places." : undefined}
            />
          ))}
        </div>
        {overCap && capCents !== undefined && (
          <Banner
            variant="error"
            icon={<Warning weight="fill" />}
            title="Over the district's cap"
            description={`The class and personal pools would total ${formatCents(generativeCents)} a month, more than the district's cap of ${formatCents(capCents)}.`}
          />
        )}
        {safetyBelowRecommended && (
          <Banner
            variant="alert"
            icon={<Warning weight="fill" />}
            title="Safety reserve below the recommended minimum"
            description={`The recommended minimum is ${formatCents(recommendedCents)} a month. You can still save a lower amount.`}
          />
        )}
        <div>
          <Button type="submit" variant="primary" disabled={!valid || overCap || changes.length === 0 || saving} loading={saving}>Review allocation changes</Button>
        </div>
      </form>

      <ConfirmDialog
        open={confirming}
        title="Change monthly allocations?"
        confirmLabel="Save allocations"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { void save(); }}
      >
        <p>These pools' monthly allocations change for the current month and every month after it:</p>
        <ul className="list-disc pl-5">
          {changes.map((change) => <li key={change.pool.poolId}>{change.pool.name}: from {formatCents(change.fromCents)} to {formatCents(change.toCents)}</li>)}
        </ul>
        {safetyBelowRecommended && <p>The safety reserve will be below its recommended minimum of {formatCents(recommendedCents)}.</p>}
        <p>Every change is kept in the allocation history.</p>
      </ConfirmDialog>
    </section>
  );
};
