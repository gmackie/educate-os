import {
  resolvePolicy,
  SCOPE_LEVELS,
  scopeContains,
  type PolicySettings,
  type Scope,
} from "@educateos/contracts";
import { DEFAULTS_PROFILES, DesiredState } from "@educateos/config";
import { DEFAULT_POLICY_RULES, type PolicyRule, type PolicySource } from "@educateos/policy";
import type { ConfigRevisionStore } from "./stores.ts";

/**
 * The district application's rule table: the A02 defaults, which since SCHO-87 include the Content
 * Studio and curriculum rules, so every service is decided by one table and audited in one trail.
 */
export const DISTRICT_APP_RULES: readonly PolicyRule[] = DEFAULT_POLICY_RULES;

/** The policy floor in force before a district applies its first configuration revision. */
export const DEFAULT_POLICY_FLOOR: PolicySettings = DEFAULTS_PROFILES["us-k12-conservative"];

/**
 * The effective policy floor from the district's applied configuration (F03): the head revision's
 * district floor, tightened by each of its overrides whose scope contains the one asked about,
 * widest first. A compiled revision never loosens the floor, so an override that would is ignored
 * rather than trusted.
 */
export function configPolicySource(config: ConfigRevisionStore, fallback: PolicySettings = DEFAULT_POLICY_FLOOR): PolicySource {
  return {
    async effectivePolicy(scope: Scope): Promise<PolicySettings> {
      const head = (await config.list()).at(-1);
      if (head === undefined) return fallback;
      const desired = DesiredState.parse(head.desired);
      const layers = desired.overrides
        .filter((override) => scopeContains(override.scope, scope))
        .toSorted((a, b) => SCOPE_LEVELS.indexOf(a.scope.level) - SCOPE_LEVELS.indexOf(b.scope.level))
        .map((override) => ({ level: override.scope.level as Exclude<Scope["level"], "district">, settings: override.settings }));
      const resolved = resolvePolicy(desired.policies, layers);
      return resolved.ok ? resolved.effective : desired.policies;
    },
  };
}
