import { useState } from "react";
import { Badge, Button, Input, Text } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { CriterionScore } from "../types.ts";
import { sourceBadge, sourceLabel } from "./feedbackSource.ts";
import { teacherScore, type ReviewCriterion } from "./rubricCriteria.ts";

/**
 * The rubric with each criterion's suggested levels beside the teacher's own score. Using a
 * suggestion only fills the box; it becomes the teacher's score when they save it.
 */
export const RubricScores = ({ submissionId, criteria, scores, onSaved }: {
  submissionId: string;
  criteria: readonly ReviewCriterion[];
  scores: readonly CriterionScore[];
  onSaved: () => void;
}) => (
  <section aria-labelledby="rubric-heading" className="flex flex-col gap-3">
    <h2 id="rubric-heading"><Text variant="heading" as="span">Rubric</Text></h2>
    {criteria.length === 0
      ? <Text variant="secondary">Run the automatic checks to bring in this rubric's criteria.</Text>
      : (
        <ul className="flex flex-col gap-3">
          {criteria.map((criterion) => (
            <li key={criterion.id}>
              <CriterionRow submissionId={submissionId} criterion={criterion} scores={scores} onSaved={onSaved} />
            </li>
          ))}
        </ul>
      )}
  </section>
);

const CriterionRow = ({ submissionId, criterion, scores, onSaved }: {
  submissionId: string;
  criterion: ReviewCriterion;
  scores: readonly CriterionScore[];
  onSaved: () => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const own = teacherScore(scores, criterion.id);
  const suggestions = scores.filter((s) => s.criterionId === criterion.id && s.source.kind === "suggested");
  const [entered, setEntered] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{ status: "idle" | "saving" } | { status: "failed"; error: unknown }>({ status: "idle" });
  const value = entered ?? (own === undefined ? "" : String(own.points));
  const maxPoints = criterion.maxPoints ?? own?.maxPoints;
  const points = value.trim() === "" ? Number.NaN : Number(value);
  const valid = Number.isFinite(points) && points >= 0 && (maxPoints === undefined || points <= maxPoints);
  const levelFor = (pts: number) => criterion.levels.find((level) => level.points === pts)?.label;

  const save = async () => {
    setState({ status: "saving" });
    try {
      await client.call("teacher.scoreCriterion", { params: { submissionId }, body: { criterionId: criterion.id, points, ...(maxPoints === undefined ? {} : { maxPoints }) } });
      setEntered(undefined);
      setState({ status: "idle" });
      announce(`Saved your score for ${criterion.title}.`);
      onSaved();
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <div role="group" aria-label={criterion.title} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
      <span className="flex flex-wrap items-center gap-2">
        <Text bold as="span">{criterion.title}</Text>
        {criterion.levels.length > 0 && <Text variant="secondary" size="sm" as="span">{criterion.levels.map((l) => `${l.label} ${l.points}`).join(" · ")}</Text>}
      </span>
      {suggestions.map((suggestion, index) => (
        <span key={index} className="flex flex-wrap items-center gap-2">
          <Badge variant={sourceBadge(suggestion.source)}>{sourceLabel(suggestion.source)}</Badge>
          <Text as="span">
            {`Suggests ${suggestion.points}${suggestion.maxPoints === undefined ? "" : ` of ${suggestion.maxPoints}`}${levelFor(suggestion.points) === undefined ? "" : ` (${levelFor(suggestion.points)})`}. Not your score until you save it.`}
          </Text>
          <Button size="sm" variant="ghost" onClick={() => setEntered(String(suggestion.points))}>{`Use ${suggestion.points}`}</Button>
        </span>
      ))}
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void save();
        }}
      >
        <Input
          label={`Your score for ${criterion.title}`}
          inputMode="decimal"
          description={maxPoints === undefined ? undefined : `Out of ${maxPoints}`}
          value={value}
          onChange={(event) => setEntered(event.target.value)}
          {...(value !== "" && !valid ? { error: maxPoints === undefined ? "Enter a number of points." : `Enter 0 to ${maxPoints}.` } : {})}
        />
        <Button type="submit" icon={<FloppyDisk aria-hidden />} disabled={!valid || entered === undefined} loading={state.status === "saving"}>Save score</Button>
      </form>
      {own !== undefined && entered === undefined && <Badge variant="neutral">{`Your score: ${own.points}${own.maxPoints === undefined ? "" : ` of ${own.maxPoints}`}`}</Badge>}
      {state.status === "failed" && <Problem error={state.error} />}
    </div>
  );
};
