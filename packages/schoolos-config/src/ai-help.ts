import type { PolicySettings, Scope } from "@schoolos/contracts";
import { DEFAULTS_PROFILES, type DefaultsProfileName, type DesiredState } from "./document.ts";

/** An AI-help level, from most permissive to strictest: `full`, `hints-only`, `none`. */
export type AiHelpLevel = NonNullable<PolicySettings["aiHelp"]>;

/**
 * The profile whose floor is in force before a district applies its first configuration revision.
 * It matches the district application's initial policy floor.
 */
export const INITIAL_DEFAULTS_PROFILE: DefaultsProfileName = "us-k12-conservative";

/** The AI-help levels set at and above an offering. The district always has one; narrower levels may. */
export interface AiHelpLayers {
  /** The district floor's level. */
  district: AiHelpLevel;
  /** The level the offering's school override sets, if it sets one. */
  school?: AiHelpLevel;
  /** The level the offering's own override sets, if it sets one. */
  offering?: AiHelpLevel;
}

/**
 * The AI-help levels a compiled configuration sets above `offering`, for services that resolve an
 * activity's level against them (curriculum's and assessment's AI-help policy sources). Without a
 * revision, the initial profile's level applies; a revision compiled before `aiHelp` existed reads
 * as its own profile's level.
 */
export function aiHelpLayersAt(desired: DesiredState | undefined, offering: Extract<Scope, { level: "offering" }>): AiHelpLayers {
  if (desired === undefined) return { district: DEFAULTS_PROFILES[INITIAL_DEFAULTS_PROFILE].aiHelp };
  const layers: AiHelpLayers = { district: desired.policies.aiHelp ?? DEFAULTS_PROFILES[desired.profile].aiHelp };
  for (const { scope, settings } of desired.overrides) {
    if (settings.aiHelp === undefined || scope.districtId !== offering.districtId || scope.schoolId !== offering.schoolId) continue;
    if (scope.level === "school") layers.school = settings.aiHelp;
    else if (scope.level === "offering" && scope.offeringId === offering.offeringId) layers.offering = settings.aiHelp;
  }
  return layers;
}
