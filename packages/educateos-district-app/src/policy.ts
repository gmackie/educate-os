import {
  resolvePolicy,
  SCOPE_LEVELS,
  scopeContains,
  type PolicySettings,
  type Scope,
} from "@educateos/contracts";
import { DEFAULTS_PROFILES, DesiredState } from "@educateos/config";
import { DEFAULT_POLICY_RULES, type PolicyRule, type PolicySource } from "@educateos/policy";
import type { ConfigurationRevision } from "@educateos/contracts";
import type { ConfigRevisionStore } from "./stores.ts";

/**
 * Told the ID of a configuration revision policy cannot read, once per revision, so the Worker can
 * log it at `error` (`config.revision.unreadable`) with its own logger.
 */
export type UnreadableRevisionReporter = (revisionId: string) => void;

/**
 * The desired state of the newest revision that parses. A head that does not (one restored from
 * before the rename that this code cannot read, say: SCHO-232) is reported and passed over for the
 * revision before it, rather than failing every policy decision in the district. With none
 * readable, the caller's fallback floor applies.
 */
function newestReadable(revisions: readonly ConfigurationRevision[], reported: Set<string>, report: UnreadableRevisionReporter): DesiredState | undefined {
  for (const revision of revisions.toReversed()) {
    const parsed = DesiredState.safeParse(revision.desired);
    if (parsed.success) return parsed.data;
    if (!reported.has(revision.id)) {
      reported.add(revision.id);
      report(revision.id);
    }
  }
  return undefined;
}

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
export function configPolicySource(
  config: ConfigRevisionStore,
  fallback: PolicySettings = DEFAULT_POLICY_FLOOR,
  onUnreadableRevision: UnreadableRevisionReporter = () => {},
): PolicySource {
  const reported = new Set<string>();
  return {
    async effectivePolicy(scope: Scope): Promise<PolicySettings> {
      const desired = newestReadable(await config.list(), reported, onUnreadableRevision);
      if (desired === undefined) return fallback;
      const layers = desired.overrides
        .filter((override) => scopeContains(override.scope, scope))
        .toSorted((a, b) => SCOPE_LEVELS.indexOf(a.scope.level) - SCOPE_LEVELS.indexOf(b.scope.level))
        .map((override) => ({ level: override.scope.level as Exclude<Scope["level"], "district">, settings: override.settings }));
      const resolved = resolvePolicy(desired.policies, layers);
      return resolved.ok ? resolved.effective : desired.policies;
    },
  };
}
