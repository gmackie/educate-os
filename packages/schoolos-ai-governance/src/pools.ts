import { z } from "zod";
import {
  DistrictId,
  Scope,
  SCOPE_LEVELS,
  scopeContains,
  TermId,
  type DistrictDirectorySnapshot,
  type PrincipalId,
} from "@schoolos/contracts";
import { ModelRef, type AiDenialReason, type AiWorkspaceContext, type FundingPurpose } from "./model.ts";
import { UsdNano } from "./money.ts";

/**
 * Identifies a funding pool. It is local to this package for now and may belong in
 * `@schoolos/contracts` once another package needs it.
 */
export const FundingPoolId = z
  .string()
  .regex(/^fpl_[a-z0-9][a-z0-9-]{0,62}$/, "expected a funding pool ID (fpl_…)")
  .brand<"fundingPool">();
/** A funding pool identifier. */
export type FundingPoolId = z.infer<typeof FundingPoolId>;

/**
 * Money a district sets aside for AI, renewed each UTC calendar month.
 *
 * A `course` pool funds only generative requests made from course workspaces within its scope. A
 * `personal` pool funds only generative personal-workspace requests, and is district-wide because
 * personal workspaces belong to no school or class. A `safety` pool funds only `safety` requests
 * (moderation) from any workspace, and is district-wide because safety spend is organizational;
 * it is protected, in that no generative request ever draws on it.
 */
export const FundingPool = z
  .strictObject({
    id: FundingPoolId,
    name: z.string().min(1).max(200),
    purpose: z.enum(["course", "personal", "safety"]),
    /** Where the pool applies. Activities are funded by their offering, so they cannot hold one. */
    scope: Scope.refine((scope) => scope.level !== "activity", "a pool is district, school or offering scoped"),
    /** The allocation for each month. Use `usdNanoFromCents` to set one from an amount in cents. */
    monthlyAllocationUsdNano: UsdNano,
    /** The only models this pool pays for. */
    allowedModels: z.array(ModelRef).min(1),
  })
  .refine((pool) => pool.purpose === "course" || pool.scope.level === "district", {
    message: "a personal or safety pool is district scoped",
    path: ["scope"],
  });
/** A funding pool. */
export type FundingPool = z.infer<typeof FundingPool>;

/**
 * A district's whole pool configuration: one district, unique IDs, and at most one personal pool
 * and one safety pool, so a personal or safety request never has to choose between two.
 */
export const FundingPoolSet = z.array(FundingPool).superRefine((pools, ctx) => {
  const ids = new Set<string>();
  for (const [index, pool] of pools.entries()) {
    if (ids.has(pool.id)) ctx.addIssue({ code: "custom", message: `duplicate pool ${pool.id}`, path: [index, "id"] });
    ids.add(pool.id);
    if (pool.scope.districtId !== pools[0]!.scope.districtId) {
      ctx.addIssue({ code: "custom", message: "every pool belongs to one district", path: [index, "scope"] });
    }
  }
  for (const purpose of ["personal", "safety"] as const) {
    if (pools.filter((pool) => pool.purpose === purpose).length > 1) {
      ctx.addIssue({ code: "custom", message: `a district has at most one ${purpose} pool` });
    }
  }
});

/**
 * The event W01 emits when a term closes. It is defined here until the workspace directory
 * publishes it; only the fields this package reads are listed. A closed term's course funding ends
 * at once, even if a stale directory snapshot still calls the term active.
 */
export const TermClosedEvent = z.strictObject({
  type: z.literal("term.closed"),
  districtId: DistrictId,
  termId: TermId,
  closedAt: z.iso.datetime(),
});
/** A term-closed event. */
export type TermClosedEvent = z.infer<typeof TermClosedEvent>;

/** The pools that may fund one request, narrowest first, and the scope its policy is read at. */
export type FundingResolution =
  | { ok: true; policyScope: Scope; pools: FundingPool[] }
  | { ok: false; reason: AiDenialReason };

/**
 * Resolves the pools that may fund a principal's request from trusted directory state.
 *
 * - A course request needs an active enrollment in the offering, and the offering's term must be
 *   `active` or `grading` with no term-closed event. A closed term's course pools fund nothing.
 *   The candidates are the course pools whose scope contains the offering, narrowest first.
 * - A personal request is funded by the district personal pool, if one is configured.
 * - A `safety` request, from either kind of workspace, is funded only by the district safety pool,
 *   read at district policy. It needs no enrollment and survives term close, because moderation
 *   protects whoever is writing, whatever their course funding; a course workspace must still name
 *   an offering of this district.
 *
 * Generative requests are only ever offered course or personal pools, never the safety pool.
 */
export function resolveFunding(
  snapshot: DistrictDirectorySnapshot,
  pools: readonly FundingPool[],
  termClosures: readonly TermClosedEvent[],
  principal: { principalId: PrincipalId; districtId: DistrictId },
  workspace: AiWorkspaceContext,
  fundingPurpose: FundingPurpose = "generative",
): FundingResolution {
  const districtId = snapshot.district.id;
  if (principal.districtId !== districtId) return { ok: false, reason: "cross-district" };
  if (!snapshot.principals.some((p) => p.id === principal.principalId)) return { ok: false, reason: "unknown-principal" };
  const districtPools = pools.filter((pool) => pool.scope.districtId === districtId);

  if (fundingPurpose === "safety") {
    if (workspace.kind === "course" && !snapshot.offerings.some((o) => o.id === workspace.offeringId)) {
      return { ok: false, reason: "unknown-offering" };
    }
    const safety = districtPools.filter((pool) => pool.purpose === "safety");
    if (safety.length === 0) return { ok: false, reason: "no-funding-pool" };
    return { ok: true, policyScope: { level: "district", districtId }, pools: safety };
  }

  if (workspace.kind === "personal") {
    const personal = districtPools.filter((pool) => pool.purpose === "personal");
    if (personal.length === 0) return { ok: false, reason: "no-funding-pool" };
    return { ok: true, policyScope: { level: "district", districtId }, pools: personal };
  }

  const offering = snapshot.offerings.find((o) => o.id === workspace.offeringId);
  if (offering === undefined) return { ok: false, reason: "unknown-offering" };
  const enrolled = snapshot.enrollments.some((e) =>
    e.offeringId === offering.id && e.principalId === principal.principalId && e.status === "active");
  if (!enrolled) return { ok: false, reason: "not-enrolled" };

  const term = snapshot.terms.find((t) => t.id === offering.termId);
  const closed = termClosures.some((event) => event.districtId === districtId && event.termId === offering.termId);
  if (term === undefined || closed || (term.state !== "active" && term.state !== "grading")) {
    return { ok: false, reason: "term-closed" };
  }

  const policyScope: Scope = { level: "offering", districtId, schoolId: offering.schoolId, offeringId: offering.id };
  const funding = districtPools
    .filter((pool) => pool.purpose === "course" && scopeContains(pool.scope, policyScope))
    .toSorted((a, b) =>
      SCOPE_LEVELS.indexOf(b.scope.level) - SCOPE_LEVELS.indexOf(a.scope.level) || a.id.localeCompare(b.id));
  if (funding.length === 0) return { ok: false, reason: "no-funding-pool" };
  return { ok: true, policyScope, pools: funding };
}
