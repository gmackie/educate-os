import { Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import type { CheckRun } from "../types.ts";

type Excerpt = NonNullable<CheckRun["run"]["report"]>["criteria"][number]["checks"][number]["evidence"][number]["excerpts"][number];

/** Resolve evidence only against the exact submitted revision; never quote current or unrelated work. */
export const CheckEvidence = ({ excerpts, work }: {
  excerpts: readonly Excerpt[];
  work: readonly { submitted: RouteResponse<"teacher.submittedContent">; label: string }[];
}) => {
  if (excerpts.length === 0) return <Text variant="secondary" size="sm">This check cites no specific passage. Review its finding against the submitted work.</Text>;
  return (
    <ul aria-label="Evidence passages" className="flex flex-col gap-2">
      {excerpts.map((excerpt, index) => {
        const source = work.find(({ submitted }) => submitted.item.artifactId === excerpt.artifact && submitted.item.revisionId === excerpt.revision);
        const content = source?.submitted.content;
        const { start, end } = excerpt.range;
        const text = content?.kind === "text" && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= content.text.length
          ? content.text.slice(start, end)
          : undefined;
        return (
          <li key={`${excerpt.artifact}:${excerpt.revision}:${index}`} className="border-l-2 border-kumo-line pl-3">
            {text === undefined ? <Text variant="error" size="sm">This passage could not be matched to the submitted revision. Review the work before using this finding.</Text> : (
              <>
                <Text bold size="sm">{source?.label}</Text>
                <blockquote className="whitespace-pre-wrap">{text}</blockquote>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
};
