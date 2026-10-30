import { useId } from "react";
import type { AssessmentReport } from "@educateos/assessment-sdk";

/** Text already authorized and digest-verified by the host's artifact service. */
export interface AuthorizedEvidenceText {
  artifactId: string;
  revisionId: string;
  digest: string;
  text: string;
}

/** Displays only supplied evidence and exact revision matches; it performs no content fetches. */
export const EvidenceViewer = ({ evidence, texts = [] }: {
  evidence: AssessmentReport["evidence"];
  texts?: readonly AuthorizedEvidenceText[];
}) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>Submitted evidence</h2>
      <p>Read-only: the submitted revision.</p>
      {evidence.length === 0 ? <p>No evidence was submitted.</p> : (
        <ul>
          {evidence.map((item) => {
            const text = texts.find((candidate) => candidate.artifactId === item.artifactId
              && candidate.revisionId === item.revisionId && candidate.digest === item.digest);
            return (
              <li key={item.id}>
                <h3>{item.id}</h3>
                <dl>
                  <dt>Requirement</dt><dd>{item.requirementId}</dd>
                  <dt>Artifact</dt><dd>{item.artifactId}</dd>
                  <dt>Revision</dt><dd>{item.revisionId}</dd>
                  <dt>Content type</dt><dd>{item.mediaType}</dd>
                  <dt>Content digest</dt><dd><code>{item.digest}</code></dd>
                </dl>
                {text === undefined
                  ? <p>Evidence content is not available in this view.</p>
                  : <pre>{text.text}</pre>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
