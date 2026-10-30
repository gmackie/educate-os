import { useId } from "react";
import type { AssessmentDefinition } from "@educateos/assessment-sdk";
import { IntentCard } from "./IntentCard.tsx";

/** A public preview of the instructions and evidence requirements, without execution or records. */
export const AssessmentPreview = ({ definition }: { definition: AssessmentDefinition }) => {
  const heading = useId();
  return (
    <article aria-label="Assessment preview">
      <IntentCard definition={definition} />
      <section aria-labelledby={heading}>
        <h2 id={heading}>What to submit</h2>
        <ol>
          {definition.tasks.map((task) => (
            <li key={task.id}>
              <h3>{task.prompt}</h3>
              <ul>
                {task.evidence.map((requirement) => (
                  <li key={requirement.id}>
                    <p>{requirement.description}</p>
                    <p>Accepted content types: {requirement.mediaTypes.join(", ")}. Maximum size: {requirement.maxBytes} bytes.</p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
};
