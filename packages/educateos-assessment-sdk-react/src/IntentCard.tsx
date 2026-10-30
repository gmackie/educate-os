import { useId } from "react";
import type { AssessmentDefinition } from "@educateos/assessment-sdk";

/** Public assessment intent and allowed AI help; this card never needs student records. */
export const IntentCard = ({ definition }: {
  definition: Pick<AssessmentDefinition, "title" | "version" | "intent" | "outcomes" | "tasks">;
}) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>{definition.title}</h2>
      <p>Version {definition.version}</p>
      <p>{definition.intent}</p>
      <h3>Learning outcomes</h3>
      <ul>
        {definition.outcomes.map((outcome) => (
          <li key={outcome.id}>
            {outcome.description}
            {outcome.caseUri === undefined ? null : <p>CASE reference: <code>{outcome.caseUri}</code></p>}
          </li>
        ))}
      </ul>
      <h3>AI assistance</h3>
      <ul>
        {definition.tasks.map((task) => (
          <li key={task.id}>
            <p>{task.prompt}</p>
            <p>{task.aiAssistance.allowedUses.length === 0
              ? "AI assistance is not allowed for this task."
              : `Allowed uses: ${task.aiAssistance.allowedUses.join(", ")}.`}</p>
            <p>{task.aiAssistance.disclosureRequired ? "Disclose any AI assistance used." : "AI assistance disclosure is not required."}</p>
          </li>
        ))}
      </ul>
    </section>
  );
};
