import { Surface, Text } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { useFeatures, useHost } from "../AppContext.tsx";
import { AI_HELP_LABEL } from "../labels.ts";
import type { AssignedActivity } from "../model.ts";

/**
 * Where the class helper opens from, on activities whose AI-help level allows one. It renders
 * nothing until the deployment turns the feature on, because the helper's route (SCHO-107) does
 * not exist yet; an entry point that leads nowhere would only confuse. A host's own helper, such as
 * the demo's simulated tutor, takes its place.
 */
export const AiHelpSlot = ({ assigned }: { assigned: AssignedActivity }) => {
  const { aiHelp } = useFeatures();
  const host = useHost();
  const level = assigned.activity.installation.aiHelp;
  if (level === "none") return null;
  if (host.aiHelp !== undefined) return host.aiHelp(assigned);
  if (!aiHelp) return null;
  return (
    <Surface as="aside" aria-labelledby="ai-help" data-slot="ai-help" className="flex items-start gap-3 rounded-lg border border-kumo-hairline p-4">
      <SparkleIcon aria-hidden size={24} />
      <div className="flex flex-col gap-1">
        <Text variant="heading" as="h2">
          <span id="ai-help">Get help</span>
        </Text>
        <Text>{AI_HELP_LABEL[level]}</Text>
      </div>
    </Surface>
  );
};
