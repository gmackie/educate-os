// Funding pool allocations as administrators set them (UI-02). The pools are deployment
// configuration; administrators change only their monthly allocations, recorded as append-only
// revisions in the `FundingAllocationStore`, which the AI ledger reads its pools through.
import { EducateOsError, type PrincipalId } from "@educateos/contracts";
import {
  formatUsdNanoAsDecimalUsd,
  usdNanoFromCents,
  usdNanoValue,
  type AiFundingReport,
  type FundingPool,
  type UsdNano,
} from "@educateos/ai-governance";
import type { FundingAllocationRevision } from "./routes.ts";
import type { FundingAllocationStore } from "./stores.ts";

/** The configured pools with the head revision's allocations applied. */
export function effectivePools(configured: readonly FundingPool[], head: FundingAllocationRevision | undefined): FundingPool[] {
  return configured.map((pool) => {
    const allocation = head?.allocations[pool.id];
    return allocation === undefined ? pool : { ...pool, monthlyAllocationUsdNano: allocation };
  });
}

/** Dollars for a message, trimmed to cents where it is a whole number of cents. */
function dollars(amount: UsdNano): string {
  return `$${formatUsdNanoAsDecimalUsd(amount).replace(/(\.\d\d)0{7}$/, "$1")}`;
}

/** One requested allocation. */
export interface AllocationRequest {
  poolId: string;
  monthlyAllocationCents: number;
}

/** The outcome of an allocation change. */
export interface AllocationChange {
  /** The revision now in force, if any. */
  revision?: FundingAllocationRevision;
  /** Whether a revision was recorded. */
  changed: boolean;
  /** Advisories the change was accepted with. */
  warnings: string[];
}

/**
 * Validates and records new allocations for some of the district's pools, as one revision.
 *
 * Every pool named must be configured, and named once. The course and personal pools' allocations
 * together may not exceed the district's overall cap, when it has one, so child allowances cannot
 * promise more than the district funds (source plan 03 §7). The safety pool is never counted
 * against that cap, and an allocation below its recommended minimum is accepted with a warning:
 * the administrator decides, and the reserve stays protected from generative use either way.
 * An unchanged allocation records nothing.
 */
export async function changeAllocations(input: {
  store: FundingAllocationStore;
  configured: readonly FundingPool[];
  requests: readonly AllocationRequest[];
  expectedRevisionId: string | undefined;
  actorPrincipalId: PrincipalId;
  districtCapUsdNano: UsdNano | undefined;
  /** The funding report before the change, for the safety reserve's recommended minimum. */
  before: AiFundingReport;
  now: Date;
}): Promise<AllocationChange> {
  const revisions = await input.store.list();
  const head = revisions.at(-1);
  if (input.expectedRevisionId !== undefined && input.expectedRevisionId !== head?.id) {
    throw new EducateOsError("conflict", "The funding allocations changed since you loaded them; review them again.");
  }

  const seen = new Set<string>();
  for (const request of input.requests) {
    if (!input.configured.some((pool) => pool.id === request.poolId)) {
      throw new EducateOsError("validation-failed", `There is no funding pool ${request.poolId} in this district.`);
    }
    if (seen.has(request.poolId)) throw new EducateOsError("validation-failed", `Funding pool ${request.poolId} is listed more than once.`);
    seen.add(request.poolId);
  }

  const current = effectivePools(input.configured, head);
  const requested = new Map(input.requests.map((request) => [request.poolId, usdNanoFromCents(request.monthlyAllocationCents)]));
  const next = current.map((pool) => ({ ...pool, monthlyAllocationUsdNano: requested.get(pool.id) ?? pool.monthlyAllocationUsdNano }));

  if (input.districtCapUsdNano !== undefined) {
    const generative = next.filter((pool) => pool.purpose !== "safety").reduce((sum, pool) => sum + usdNanoValue(pool.monthlyAllocationUsdNano), 0n);
    if (generative > usdNanoValue(input.districtCapUsdNano)) {
      throw new EducateOsError(
        "validation-failed",
        `The course and personal pools would total ${dollars(generative.toString())} a month, more than the district's cap of ${dollars(input.districtCapUsdNano)}.`,
      );
    }
  }

  const warnings: string[] = [];
  const safety = next.find((pool) => pool.purpose === "safety");
  const recommended = input.before.safety.recommendedMinimumUsdNano;
  if (safety !== undefined && usdNanoValue(safety.monthlyAllocationUsdNano) < usdNanoValue(recommended)) {
    warnings.push(`The safety reserve is ${dollars(safety.monthlyAllocationUsdNano)} a month, below the recommended ${dollars(recommended)}.`);
  }

  if (next.every((pool, index) => pool.monthlyAllocationUsdNano === current[index]!.monthlyAllocationUsdNano)) {
    return { ...(head === undefined ? {} : { revision: head }), changed: false, warnings };
  }
  const revision: FundingAllocationRevision = {
    id: `far_${crypto.randomUUID()}`,
    number: revisions.length + 1,
    allocations: Object.fromEntries(next.map((pool) => [pool.id, pool.monthlyAllocationUsdNano])),
    actorPrincipalId: input.actorPrincipalId,
    appliedAt: input.now.toISOString(),
    ...(head === undefined ? {} : { previousRevisionId: head.id }),
  };
  await input.store.append(revision, head?.id);
  return { revision, changed: true, warnings };
}
