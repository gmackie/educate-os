import { useId } from "react";
import { canonicalJson, type AssessmentDefinition } from "@educateos/assessment-sdk";

/** Compares public definition sections; a content pin change remains visible at the same version. */
export const VersionDiff = ({ before, after }: {
  before: AssessmentDefinition;
  after: AssessmentDefinition;
}) => {
  const heading = useId();
  const sections = [
    ["Title", "title"],
    ["Learning intent", "intent"],
    ["Learning outcomes", "outcomes"],
    ["Tasks, evidence requirements or AI permissions", "tasks"],
    ["Rubric release", "rubric"],
    ["Evaluator release", "evaluator"],
  ] as const;
  const changed = sections.filter(([, key]) => canonicalJson(before[key]) !== canonicalJson(after[key]));
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>Assessment changes</h2>
      <p>Version {before.version} to {after.version}</p>
      {before.id === after.id ? null : <p>These definitions have different assessment identifiers.</p>}
      {changed.length === 0 ? <p>No changes to the assessment content.</p> : (
        <ul>{changed.map(([label, key]) => <li key={key}>{label} changed.</li>)}</ul>
      )}
      <p>Review both assessment previews before adopting a new release.</p>
    </section>
  );
};
