import {
  resolvePolicy,
  SCOPE_LEVELS,
  scopeContains,
  type PolicySettings,
  type Scope,
} from "@schoolos/contracts";
import { DEFAULTS_PROFILES, DesiredState } from "@schoolos/config";
import { DEFAULT_POLICY_RULES, PolicyRuleTable, type PolicyRule, type PolicySource } from "@schoolos/policy";
import type { ConfigRevisionStore } from "./stores.ts";

/**
 * The Content Studio's grants (C03's `contentStudioAuthorizer`), adopted into the district's one
 * rule table so the studio is decided by the same engine, and audited in the same trail, as every
 * other service. The studio authorizes every item as a `teacher-only` learning resource at its
 * target scope; a teacher's roles are offering-scoped, so a teacher imports and approves only for
 * classes they teach. These rules only allow, and come after every default guard.
 */
export const CONTENT_STUDIO_RULES: readonly PolicyRule[] = PolicyRuleTable.parse([
  {
    id: "content-studio.teacher.offering",
    description: "A teacher imports, reviews, approves, publishes and uses learning resources for the classes they teach.",
    when: {
      kinds: ["learning-resource"],
      roles: ["teacher"],
      classifications: ["teacher-only"],
      actions: ["create", "list", "read", "update", "approve", "publish", "assign"],
    },
    effect: { effect: "allow" },
  },
  {
    id: "content-studio.curriculum-admin.manage",
    description: "A curriculum admin also uses resources in classes and widens an item's rights.",
    when: { kinds: ["learning-resource"], roles: ["curriculum-admin"], classifications: ["teacher-only"], actions: ["assign", "configure"] },
    effect: { effect: "allow" },
  },
]);

/** The district application's rule table: the A02 defaults, then {@link CONTENT_STUDIO_RULES}. */
export const DISTRICT_APP_RULES: readonly PolicyRule[] = [...DEFAULT_POLICY_RULES, ...CONTENT_STUDIO_RULES];

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
