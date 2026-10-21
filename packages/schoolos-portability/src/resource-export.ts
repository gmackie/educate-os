import { CapabilityId } from "@schoolos/contracts";
import type { DesiredState } from "@schoolos/config";
import type { PolicyRule } from "@schoolos/policy";

/**
 * The district's grant letting learners export copies of class resources (roadmap §5.3). The v1
 * rule table has no `export` grant for learning resources, so without it every resource a
 * learner's classes used is exported as a reference. With it, an actively enrolled student may
 * export a `course` resource of their offering; the exporter still copies it only when its rights
 * permit redistribution (`mayRedistribute`), so the grant never reaches link-only or licensed
 * material.
 */
export const LEARNER_RESOURCE_EXPORT_RULE: PolicyRule = {
  id: "portability.learner.resource-export",
  description: "An actively enrolled student exports a copy of their class's resources, where the district allows it and each resource's rights permit redistribution.",
  when: { kinds: ["learning-resource"], actions: ["export"], roles: ["student"], classifications: ["course"] },
  effect: { effect: "allow" },
};

/**
 * `rules` with {@link LEARNER_RESOURCE_EXPORT_RULE} appended when `enabled`. Appended, it can only
 * turn the default deny into an allow: every guard and grant before it still decides first.
 */
export function withLearnerResourceExport(rules: readonly PolicyRule[], enabled: boolean): PolicyRule[] {
  return enabled ? [...rules, LEARNER_RESOURCE_EXPORT_RULE] : [...rules];
}

const STUDENT_PORTABILITY = CapabilityId.parse("student-portability");

/**
 * Whether the district turned on learner resource export: the `student-portability` pack is
 * enabled and its `redistributableResourceExport` setting is on. It is off by default.
 */
export function learnerResourceExportEnabled(desired: DesiredState): boolean {
  const pack = desired.modules[STUDENT_PORTABILITY];
  return pack?.state === "enabled" && pack.config["redistributableResourceExport"] === true;
}
