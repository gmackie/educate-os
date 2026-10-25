import { useState } from "react";
import { Checkbox, Input, Text } from "@cloudflare/kumo";
import type { LearningGoal } from "../types.ts";
import { goalKey, goalLabel } from "./activityForm.ts";

/** Where a district administrator approves learning standards: the admin console's page, served beside Teacher Studio. */
export const LEARNING_STANDARDS_HREF = "/admin/#/learning-standards";

/** How many unchosen goals are listed before the teacher narrows them with a search. */
const SHOWN = 30;

const matches = (goal: LearningGoal, query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const text = `${goalLabel(goal)} ${goal.statement}`.toLowerCase();
  return words.every((word) => text.includes(word));
};

/**
 * Choosing an activity's learning goals from those the district approved for the class. Goals are
 * optional, so an empty list says why and where they come from instead of blocking the teacher.
 */
export const LearningGoalPicker = ({ goals, approvedReleases, chosen, onChange }: {
  goals: readonly LearningGoal[];
  /** How many standards releases the district approved at all, to tell "none approved" from "none fit". */
  approvedReleases: number;
  chosen: readonly string[];
  onChange: (chosen: string[]) => void;
}) => {
  const [query, setQuery] = useState("");

  if (goals.length === 0) {
    const why = approvedReleases === 0
      ? "Your district hasn't approved any learning standards yet."
      : "None of the learning standards your district approved cover this course's subject and grades.";
    return (
      <Text variant="secondary">
        {`${why} Learning goals are optional, so you can create this activity without them. A district administrator can approve standards on the `}
        <a href={LEARNING_STANDARDS_HREF}>Learning standards page</a>.
      </Text>
    );
  }

  const selected = goals.filter((goal) => chosen.includes(goalKey(goal)));
  const found = goals.filter((goal) => !chosen.includes(goalKey(goal)) && matches(goal, query));
  const toggle = (goal: LearningGoal, on: boolean) => onChange(on ? [...chosen, goalKey(goal)] : chosen.filter((key) => key !== goalKey(goal)));
  const option = (goal: LearningGoal) => (
    <Checkbox
      key={goalKey(goal)}
      label={<span><span className="font-medium">{goalLabel(goal)}</span> <span className="text-kumo-subtle">{goal.statement}</span></span>}
      checked={chosen.includes(goalKey(goal))}
      onCheckedChange={(on) => toggle(goal, on === true)}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <Text variant="secondary">Optional. Choose the standards this activity gathers evidence of.</Text>
      {selected.map(option)}
      <Input label="Find a learning goal" placeholder="A code or a few words, such as W.9-10.1 or argument" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {found.slice(0, SHOWN).map(option)}
      </div>
      <div role="status">
        <Text variant="secondary" size="sm">
          {found.length === 0
            ? "No other learning goals match."
            : found.length > SHOWN ? `Showing ${SHOWN} of ${found.length}. Type a code or a few words to narrow the list.` : `${found.length} more to choose from.`}
        </Text>
      </div>
    </div>
  );
};
