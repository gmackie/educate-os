// The AI-help policy of an activity, read from its installed definition (C05) rather than asserted
// by whoever wires the service up. The district's compiled configuration (F03) may tighten it
// further; that layer wraps this source (SCHO-88's `compiledConfigAiHelpPolicies`).
import type { ActivityId } from "@schoolos/contracts";
import type { ActivityInstallation, AiHelpLevel } from "@schoolos/curriculum";
import type { AiHelpPolicy, AiHelpPolicySource } from "./profiles.ts";

/**
 * The most AI feedback an activity's AI-help level allows. AI feedback on a student's work is help
 * with the work itself, so only `full` lets it reach the student; under `hints-only` it stays
 * advice to the teacher, and under `none` no AI reads the work.
 */
export const AI_FEEDBACK_FOR_HELP_LEVEL: Readonly<Record<AiHelpLevel, AiHelpPolicy>> = {
  full: "releasable",
  "hints-only": "teacher-only",
  none: "none",
};

/**
 * The {@link AiHelpPolicySource} backed by the curriculum's installed activities: an activity's
 * policy follows the AI-help level its installation pinned, which the curriculum service checked
 * against the district and offering policy when it was installed. An activity that is not
 * installed has no policy, which the assessment service reads as `none`.
 */
export function activityAiHelpPolicies(installations: { getInstallation(id: ActivityId): Promise<ActivityInstallation | undefined> }): AiHelpPolicySource {
  return {
    async aiHelpPolicy(activityId) {
      const installation = await installations.getInstallation(activityId);
      return installation === undefined ? undefined : AI_FEEDBACK_FOR_HELP_LEVEL[installation.aiHelp];
    },
  };
}
