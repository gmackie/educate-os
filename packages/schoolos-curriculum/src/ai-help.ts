import { z } from "zod";
import type { OfferingScope } from "./ids.ts";

/**
 * How much an AI helper may do for a student on an activity, from most permissive to strictest.
 * `full` helps with the work itself, `hints-only` may only point the way, and `none` offers no
 * helper at all. The order is the rule: a narrower level may only move toward `none`.
 *
 * This is a policy floor setting like those in the contracts `PolicySettings`, and may join them
 * once the configuration compiler (F03) carries it.
 */
export const AI_HELP_LEVELS = ["full", "hints-only", "none"] as const;

/** One of {@link AI_HELP_LEVELS}. */
export const AiHelpLevel = z.enum(AI_HELP_LEVELS);
/** An AI-help level. */
export type AiHelpLevel = z.infer<typeof AiHelpLevel>;

/** The AI-help levels set above an activity. The district always sets one; narrower levels may. */
export const AiHelpLayers = z.strictObject({
  district: AiHelpLevel,
  school: AiHelpLevel.optional(),
  offering: AiHelpLevel.optional(),
});
/** The AI-help levels above an activity. */
export type AiHelpLayers = z.infer<typeof AiHelpLayers>;

/** A level that tried to loosen the AI-help level in force above it. */
export interface AiHelpViolation {
  /** The level whose setting was refused. */
  level: "school" | "offering" | "activity";
  /** The level in force from the wider levels. */
  floor: AiHelpLevel;
  /** The looser level requested. */
  requested: AiHelpLevel;
}

/** The activity's effective AI-help level, or every setting that would have loosened it. */
export type AiHelpResolution =
  | { ok: true; effective: AiHelpLevel }
  | { ok: false; violations: AiHelpViolation[] };

/**
 * Resolves the district level, then school, offering and the activity's own request, each of
 * which may only tighten. Every loosening is reported, as `resolvePolicy` does in contracts.
 */
export function resolveAiHelp(layers: AiHelpLayers, requested: AiHelpLevel): AiHelpResolution {
  let effective = layers.district;
  const violations: AiHelpViolation[] = [];
  const narrower = [["school", layers.school], ["offering", layers.offering], ["activity", requested]] as const;
  for (const [level, value] of narrower) {
    if (value === undefined) continue;
    if (AI_HELP_LEVELS.indexOf(value) < AI_HELP_LEVELS.indexOf(effective)) {
      violations.push({ level, floor: effective, requested: value });
    } else {
      effective = value;
    }
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true, effective };
}

/**
 * Where the AI-help levels above an offering come from: the district's compiled configuration
 * (F03) in production. Read at publication and again at installation, so an activity published
 * under a looser policy cannot be installed after the district tightens it.
 */
export interface AiHelpPolicySource {
  layersFor(offering: OfferingScope): Promise<AiHelpLayers>;
}
