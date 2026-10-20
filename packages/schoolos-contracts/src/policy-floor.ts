import { z } from "zod";
import { ScopeLevel, SCOPE_LEVELS } from "./scope.ts";

/**
 * The governance settings that form a district's policy floor (roadmap §4). Each enumerated
 * setting lists its values from most permissive to strictest, and a narrower scope may only move
 * toward the strict end. That ordering is the whole rule: no school, teacher or activity setting
 * can loosen what the district set, however it is phrased.
 */
export const POLICY_ORDERINGS = {
  aiSpending: ["capped", "disabled"],
  promptsInGatewayLogs: ["permitted", "prohibited"],
  studentPersonalConversations: ["shared-by-student", "private"],
  teacherObservation: ["assigned-work-and-shared-conversations", "assigned-work-only"],
  automatedSelProfiling: ["permitted-with-review", "prohibited"],
} as const;

/** The name of an enumerated policy setting. */
export type OrderedPolicyKey = keyof typeof POLICY_ORDERINGS;

/**
 * A complete policy. The district level must set every field; it is the floor every narrower
 * level resolves against.
 */
export const PolicySettings = z.strictObject({
  aiSpending: z.enum(POLICY_ORDERINGS.aiSpending),
  promptsInGatewayLogs: z.enum(POLICY_ORDERINGS.promptsInGatewayLogs),
  studentPersonalConversations: z.enum(POLICY_ORDERINGS.studentPersonalConversations),
  teacherObservation: z.enum(POLICY_ORDERINGS.teacherObservation),
  automatedSelProfiling: z.enum(POLICY_ORDERINGS.automatedSelProfiling),
  /** Monthly AI spend cap per principal, in US cents. Lower is stricter. */
  aiMonthlyCapCentsPerPrincipal: z.int().nonnegative(),
});
/** A complete policy. */
export type PolicySettings = z.infer<typeof PolicySettings>;

/** The settings a narrower level overrides; anything it omits is inherited. */
export const PolicyOverrides = PolicySettings.partial();
/** Policy overrides. */
export type PolicyOverrides = z.infer<typeof PolicyOverrides>;

/** The levels beneath the district, which may only tighten its floor. */
export type NarrowerScopeLevel = Exclude<ScopeLevel, "district">;

/** One narrower level's contribution to the effective policy. */
export interface PolicyLayer {
  /** The level that set these values. */
  level: NarrowerScopeLevel;
  /** The values it set. */
  settings: PolicyOverrides;
}

/** A setting a narrower level tried to loosen. */
export interface PolicyViolation {
  /** The level whose setting was refused. */
  level: NarrowerScopeLevel;
  /** The setting. */
  key: keyof PolicySettings;
  /** The value in force from the wider levels. */
  floor: unknown;
  /** The looser value requested. */
  requested: unknown;
}

/** The effective policy, or every override that would have loosened it. */
export type PolicyResolution =
  | { ok: true; effective: PolicySettings }
  | { ok: false; violations: PolicyViolation[] };

function isLooser(key: keyof PolicySettings, floor: unknown, requested: unknown): boolean {
  if (key === "aiMonthlyCapCentsPerPrincipal") return (requested as number) > (floor as number);
  const order: readonly unknown[] = POLICY_ORDERINGS[key];
  return order.indexOf(requested) < order.indexOf(floor);
}

/**
 * Resolves the district floor and then the narrower layers in school → offering → activity order,
 * each of which may only tighten. Every loosening attempt is
 * reported rather than the first, so an administrator sees the whole conflict at once.
 */
export function resolvePolicy(district: PolicySettings, narrower: PolicyLayer[]): PolicyResolution {
  const ordered = narrower.toSorted(
    (a, b) => SCOPE_LEVELS.indexOf(a.level) - SCOPE_LEVELS.indexOf(b.level),
  );
  const effective: PolicySettings = { ...district };
  const violations: PolicyViolation[] = [];
  for (const layer of ordered) {
    for (const key of Object.keys(layer.settings) as (keyof PolicySettings)[]) {
      const requested = layer.settings[key];
      if (requested === undefined) continue;
      if (isLooser(key, effective[key], requested)) {
        violations.push({ level: layer.level, key, floor: effective[key], requested });
      } else {
        (effective as Record<keyof PolicySettings, unknown>)[key] = requested;
      }
    }
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true, effective };
}
