import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import type { ActivityDefinition, ResourceRelease } from "../types.ts";
import { AI_HELP } from "./activityForm.ts";

/**
 * The activity as a student will see it: the steps, the resources and the notes shared with
 * students. Teacher-only notes and the answer key are left out, exactly as the district leaves them
 * out of the student's copy.
 */
export const StudentPreview = ({ definition, releases }: { definition: ActivityDefinition; releases: readonly ResourceRelease[] }) => {
  const { content } = definition;
  const titleOf = (resourceId: string) => releases.find((r) => r.descriptor.id === resourceId)?.descriptor.title ?? "A class resource";
  const shared = content.codex.filter((entry) => entry.visibility === "students");
  return (
    <section aria-labelledby="preview-heading" className="flex flex-col gap-3">
      <h2 id="preview-heading"><Text variant="heading" as="span">Preview as a student</Text></h2>
      <LayerCard className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <Text variant="heading" size="lg" as="h3">{content.title}</Text>
          <Text>{content.overview}</Text>
          <span><Badge variant="neutral">{`AI help: ${AI_HELP.find((h) => h.level === content.aiHelp)?.label ?? content.aiHelp}`}</Badge></span>
        </div>
        <ol className="flex flex-col gap-3">
          {content.steps.map((step, index) => (
            <li key={step.id} className="flex flex-col gap-1">
              <Text bold as="span">{`Step ${index + 1}: ${step.title}`}</Text>
              <Text as="span"><span className="whitespace-pre-line">{step.prompt}</span></Text>
            </li>
          ))}
        </ol>
        {content.resources.length > 0 && (
          <div className="flex flex-col gap-1">
            <Text bold as="span">Resources</Text>
            <ul className="list-disc pl-5">{content.resources.map((r) => <li key={`${r.resourceId}@${r.version}`}>{titleOf(r.resourceId)}</li>)}</ul>
          </div>
        )}
        {shared.some((entry) => entry.kind === "note") && (
          <div className="flex flex-col gap-1">
            <Text bold as="span">Notes from your teacher</Text>
            <ul className="flex flex-col gap-2">
              {shared.flatMap((entry) => (entry.kind === "note" ? [
                <li key={entry.id}><Text bold as="span">{entry.title}</Text><Text as="span"><span className="block whitespace-pre-line">{entry.body}</span></Text></li>,
              ] : []))}
            </ul>
          </div>
        )}
      </LayerCard>
    </section>
  );
};
