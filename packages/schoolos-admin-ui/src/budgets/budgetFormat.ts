// How the AI budgets screen names pools, thresholds and amounts. Budget amounts are shown exactly,
// not rounded to the cent: a moderation check costs a fraction of a cent, and a reserve that has
// paid for a thousand of them must not read as $0.00 or as a whole number of cents it never spent.
import type { RouteResponse } from "@schoolos/api-client";
import { className, schoolName } from "../app/labels.ts";

/** Where the district's funding stands this month. */
export type FundingReport = RouteResponse<"admin.aiFunding">["report"];
/** One pool's position this month. */
export type PoolStatus = FundingReport["pools"][number];
/** How close a pool is to its allocation. */
export type BudgetThreshold = PoolStatus["threshold"];

const USD_NANO_PER_USD = 1_000_000_000n;

/**
 * An amount in nanodollars as exact dollars: at least two decimal places, and as many more as it
 * needs. 38,000 nanodollars reads "$0.000038"; 1,500,000,000 reads "$1.50".
 */
export function formatUsdNanoExact(usdNano: string): string {
  const value = BigInt(usdNano);
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % USD_NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${value < 0n ? "-" : ""}$${(magnitude / USD_NANO_PER_USD).toLocaleString("en-US")}.${fraction}`;
}

/** Whole cents from an amount in nanodollars, rounded down; allocations are always whole cents. */
export function usdNanoToWholeCents(usdNano: string): number {
  return Number(BigInt(usdNano) / 10_000_000n);
}

/** The most one pool may be allocated, in cents: $1,000,000 a month, as the district enforces. */
export const MAX_ALLOCATION_CENTS = 100_000_000;

/**
 * Whole cents from a dollar amount an administrator typed ("12", "12.5", "$1,200.00"), or
 * undefined if it is not a non-negative amount with at most two decimal places within the limit.
 */
export function parseDollarsToCents(text: string): number | undefined {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim().replaceAll(",", ""));
  if (match === null) return undefined;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return cents <= MAX_ALLOCATION_CENTS ? cents : undefined;
}

/** Whole cents as a dollar amount for an input: 1250 reads "12.50". */
export function centsToDollarsInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** What each pool purpose funds, as an administrator reads it. */
export const PURPOSE_LABELS: Record<PoolStatus["purpose"], string> = {
  course: "Classes",
  personal: "Personal spaces",
  safety: "Safety reserve",
};

/** Where a pool applies. */
export function scopeLabel(scope: PoolStatus["scope"]): string {
  switch (scope.level) {
    case "district": return "Whole district";
    case "school": return `School ${schoolName(scope.schoolId)}`;
    case "offering": return `Class ${className(scope.offeringId)}`;
    case "activity": return `Activity in class ${className(scope.offeringId)}`;
  }
}

/** Each threshold's badge: its words and Kumo's semantic status variant. */
export const THRESHOLD_BADGES: Record<BudgetThreshold, { label: string; variant: "success" | "info" | "warning" | "error" }> = {
  none: { label: "On track", variant: "success" },
  info: { label: "70% used", variant: "info" },
  warning: { label: "85% used", variant: "warning" },
  critical: { label: "95% used", variant: "error" },
  exhausted: { label: "Used up", variant: "error" },
};

/** A utilization as text: "85.37%", or "No allocation" when the pool has none. */
export function formatPercent(percent: number | null): string {
  return percent === null ? "No allocation" : `${percent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}
