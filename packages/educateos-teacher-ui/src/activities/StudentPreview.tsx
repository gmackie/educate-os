import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import { DistrictApiError } from "@educateos/api-client";
import type { ActivityDefinition, ResourceRelease, RubricRef } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { AI_HELP } from "./activityForm.ts";
import { useRubricShelf } from "./RubricShelf.tsx";

type Step = ActivityDefinition["content"]["steps"][number];

/** What a step asks the student to hand in, where it says more than its prompt. */
const responseNote = (response: Step["response"]): string | undefined => {
  switch (response.kind) {
    case "dataset":
      return `A table with columns: ${response.columns.map((c) => (c.unit === undefined ? c.name : `${c.name} (${c.unit})`)).join(", ")}.`;
    case "writing":
      return response.minWords === undefined ? undefined : `At least ${response.minWords} words.`;
    default:
      return undefined;
  }
};

/**
 * The rubric's criteria and levels, as students see them. A rubric saved in this session is on
 * the shelf; one an earlier activity used is read back from the district. Its checks are left
 * out: students see what they are assessed on, not how the checks work.
 */
const PreviewRubric = ({ offeringId, rubric }: { offeringId: string; rubric: RubricRef }) => {
  const shelf = useRubricShelf();
  const onShelf = shelf.rubrics.find((r) => r.rubricId === rubric.rubricId && r.version === rubric.version);
  const loaded = useLoad(`preview-rubric:${rubric.rubricId}@${rubric.version}`, async (client) =>
    onShelf ?? client.call("teacher.getRubric", { params: { offeringId, rubricId: rubric.rubricId, version: String(rubric.version) } }).catch((error: unknown) => {
      if (error instanceof DistrictApiError && error.code === "not-found") return undefined;
      throw error;
    }));
  const release = onShelf ?? (loaded.status === "ready" ? loaded.data : undefined);
  if (release === undefined) return null;
  return (
    <div className="flex flex-col gap-1">
      <Text bold as="span">{`How your work is assessed: ${release.title}`}</Text>
      <ul className="flex flex-col gap-1 pl-5 list-disc">
        {release.criteria.map((criterion) => (
          <li key={criterion.id}>
            <Text as="span">{`${criterion.title}: ${criterion.levels.map((l) => `${l.label} (${l.points})`).join(", ")}`}</Text>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * The activity as a student will see it: the steps and what each asks for, the resources, the
 * rubric and the notes shared with students. Teacher-only notes and the answer key are left out,
 * exactly as the district leaves them out of the student's copy.
 */
export const StudentPreview = ({ definition, releases, offeringId, rubric }: {
  definition: ActivityDefinition;
  releases: readonly ResourceRelease[];
  offeringId: string;
  /** The rubric the activity will be assessed against, if any. */
  rubric: RubricRef | undefined;
}) => {
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
              {responseNote(step.response) !== undefined && <Text variant="secondary" size="sm" as="span">{responseNote(step.response)}</Text>}
            </li>
          ))}
        </ol>
        {content.resources.length > 0 && (
          <div className="flex flex-col gap-1">
            <Text bold as="span">Resources</Text>
            <ul className="list-disc pl-5">{content.resources.map((r) => <li key={`${r.resourceId}@${r.version}`}>{titleOf(r.resourceId)}</li>)}</ul>
          </div>
        )}
        {rubric !== undefined && <PreviewRubric offeringId={offeringId} rubric={rubric} />}
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
