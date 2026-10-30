import { useId } from "react";
import type { AssessmentReport } from "@educateos/assessment-sdk";

/** Evidence-grounded suggestions for a teacher to review; never presents an official grade. */
export const RubricReview = ({ report }: {
  report: Pick<AssessmentReport, "findings" | "evidence">;
}) => {
  const heading = useId();
  const available = new Set(report.evidence.map((evidence) => evidence.id));
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>Rubric review</h2>
      <p>Suggestions only. A teacher decides the official grade.</p>
      {report.findings.length === 0 ? <p>No evaluation findings are available.</p> : (
        <ul>
          {report.findings.map((finding, index) => (
            <li key={`${finding.criterionId}-${index}`}>
              <h3>{finding.criterionId}</h3>
              <p>{finding.observation}</p>
              <p>{finding.explanation}</p>
              {finding.score === undefined ? null : <p>Suggested score: {Math.round(finding.score * 100)}%</p>}
              <p>Evidence: {finding.evidenceIds.filter((id) => available.has(id)).join(", ") || "No supporting evidence is available in this view."}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
