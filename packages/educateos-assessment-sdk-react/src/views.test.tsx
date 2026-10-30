import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { getByRole, getByText, queryByText } from "@testing-library/dom";
import { afterEach, describe, expect, it } from "vitest";
import type { AssessmentDefinition, AssessmentReport } from "@educateos/assessment-sdk";
import { IntentCard } from "./IntentCard.tsx";
import { EvidenceViewer } from "./EvidenceViewer.tsx";
import { RubricReview } from "./RubricReview.tsx";
import { AssessmentPreview } from "./AssessmentPreview.tsx";
import { VersionDiff } from "./VersionDiff.tsx";

const digest = `sha256:${"a".repeat(64)}`;
const definition: AssessmentDefinition = {
  format: "educateos.assessment.v1",
  id: "public-writing",
  version: "1.0.0",
  title: "Explain the water cycle",
  intent: "Use evidence to explain evaporation.",
  outcomes: [{ id: "explain", description: "Explain a scientific process.", caseUri: "https://example.edu/case/water" }],
  rubric: { id: "water-rubric", version: "1.0.0", digest },
  evaluator: { id: "writing.structure", version: "1.0.0", digest },
  tasks: [{
    id: "writing",
    kind: "writing",
    prompt: "Explain evaporation in your own words.",
    aiAssistance: { allowedUses: ["brainstorm"], disclosureRequired: true },
    evidence: [{ id: "essay", description: "Submit your explanation.", mediaTypes: ["text/plain"], maxBytes: 4096 }],
  }],
};
const evidence: AssessmentReport["evidence"] = [{
  id: "evidence-1", requirementId: "essay", artifactId: "art_essay", revisionId: "rev_first", digest, mediaType: "text/plain",
}];

let renderCount = 0;
afterEach(() => document.body.replaceChildren());
const render = (view: ReactNode) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(view, { identifierPrefix: `view-${renderCount++}-` });
  document.body.append(container);
  return container;
};

describe("portable teacher views", () => {
  it("shows task-scoped AI permissions and disclosure alongside intent and CASE reference", () => {
    const view = render(<IntentCard definition={definition} />);
    expect(getByRole(view, "region", { name: definition.title })).toBeTruthy();
    expect(getByText(view, definition.intent)).toBeTruthy();
    expect(getByText(view, "Allowed uses: brainstorm.")).toBeTruthy();
    expect(getByText(view, "Disclose any AI assistance used.")).toBeTruthy();
    expect(getByText(view, "https://example.edu/case/water")).toBeTruthy();
    const disallowed = render(<IntentCard definition={{ ...definition, tasks: [{ ...definition.tasks[0]!, aiAssistance: { allowedUses: [], disclosureRequired: false } }] }} />);
    expect(getByText(disallowed, "AI assistance is not allowed for this task.")).toBeTruthy();
  });

  it("previews exactly the public submission requirements", () => {
    const view = render(<AssessmentPreview definition={definition} />);
    expect(getByRole(view, "article", { name: "Assessment preview" })).toBeTruthy();
    expect(getByText(view, "Submit your explanation.")).toBeTruthy();
    expect(getByText(view, "Accepted content types: text/plain. Maximum size: 4096 bytes.")).toBeTruthy();
  });

  it("does not show another revision's text, even when artifact or digest matches", () => {
    const view = render(<EvidenceViewer evidence={evidence} texts={[
      { artifactId: "art_essay", revisionId: "rev_newer", digest, text: "Unsubmitted edits" },
      { artifactId: "art_essay", revisionId: "rev_first", digest: `sha256:${"b".repeat(64)}`, text: "Tampered text" },
      { artifactId: "art_elsewhere", revisionId: "rev_first", digest, text: "Other student's text" },
    ]} />);
    expect(getByText(view, "Evidence content is not available in this view.")).toBeTruthy();
    expect(queryByText(view, "Unsubmitted edits")).toBeNull();
    expect(queryByText(view, "Tampered text")).toBeNull();
    expect(queryByText(view, "Other student's text")).toBeNull();
  });

  it("shows authorized submitted text as text, including HTML-looking work", () => {
    const text = '<script>alert("not executable")</script>';
    const view = render(<EvidenceViewer evidence={evidence} texts={[
      { artifactId: "art_essay", revisionId: "rev_first", digest, text },
    ]} />);
    expect(getByText(view, text)).toBeTruthy();
    expect(view.querySelector("script")).toBeNull();
    expect(getByText(view, "Read-only: the submitted revision.")).toBeTruthy();
  });

  it("labels evaluator observations and scores as suggestions, with inspectable evidence", () => {
    const view = render(<RubricReview report={{ evidence, findings: [{
      criterionId: "explain", observation: "The explanation has a beginning and conclusion.",
      explanation: "The submitted text includes both sections.", evidenceIds: ["evidence-1"], score: 0.75,
    }] }} />);
    expect(getByText(view, "Suggestions only. A teacher decides the official grade.")).toBeTruthy();
    expect(getByText(view, "Suggested score: 75%")).toBeTruthy();
    expect(getByText(view, "Evidence: evidence-1")).toBeTruthy();
    expect(view.querySelector("button")).toBeNull();
  });

  it("gives an explicit empty state instead of treating missing findings as success", () => {
    expect(getByText(render(<RubricReview report={{ evidence: [], findings: [] }} />), "No evaluation findings are available.")).toBeTruthy();
    expect(getByText(render(<EvidenceViewer evidence={[]} />), "No evidence was submitted.")).toBeTruthy();
  });

  it("shows changed AI permissions and rubric content even when a version label is unchanged", () => {
    const after: AssessmentDefinition = {
      ...definition,
      rubric: { ...definition.rubric, digest: `sha256:${"b".repeat(64)}` },
      tasks: [{ ...definition.tasks[0]!, aiAssistance: { allowedUses: [], disclosureRequired: true } }],
    };
    const view = render(<VersionDiff before={definition} after={after} />);
    expect(getByText(view, "Tasks, evidence requirements or AI permissions changed.")).toBeTruthy();
    expect(getByText(view, "Rubric release changed.")).toBeTruthy();
    expect(queryByText(view, "Evaluator release changed.")).toBeNull();
    const equal = render(<VersionDiff before={definition} after={{ ...definition, version: "1.0.1" }} />);
    expect(getByText(equal, "No changes to the assessment content.")).toBeTruthy();
  });
});
