import type { ActivityStep, ArtifactRead, ArtifactType } from "../model.ts";

/** A dataset column a lab step asks for. */
export type DatasetColumn = Extract<ActivityStep["response"], { kind: "dataset" }>["columns"][number];

/**
 * How the student produces a step's work, and what it is saved as:
 * - `writing`: typed text, saved as a plain-text document.
 * - `dataset`: a table of observations, saved as CSV.
 * - `upload`: a text or CSV file from the device, saved as its text.
 * - `link`: a link to work kept in the school's approved document service.
 * - `unsupported`: a file kind the district API cannot take yet (photos, recordings, slides).
 */
export type WorkMode =
  | { input: "writing"; artifactType: "document"; mediaType: "text/plain" }
  | { input: "dataset"; artifactType: "dataset"; mediaType: "text/csv"; columns: DatasetColumn[] }
  | { input: "upload"; artifactType: ArtifactType; mediaType: "text/plain" | "text/csv"; accept: string }
  | { input: "link"; artifactType: "external-ref" }
  | { input: "unsupported"; artifactType: ArtifactType };

/** The way a step's work is produced, or undefined for a step that produces nothing. */
export const workModeFor = (step: ActivityStep): WorkMode | undefined => {
  const response = step.response;
  switch (response.kind) {
    case "none":
      return undefined;
    case "writing":
      return { input: "writing", artifactType: "document", mediaType: "text/plain" };
    case "dataset":
      return { input: "dataset", artifactType: "dataset", mediaType: "text/csv", columns: response.columns };
    case "artifact":
      switch (response.artifactType) {
        case "document":
          return { input: "upload", artifactType: "document", mediaType: "text/plain", accept: ".txt,.md,text/plain,text/markdown" };
        case "dataset":
        case "spreadsheet":
          return { input: "upload", artifactType: response.artifactType, mediaType: "text/csv", accept: ".csv,text/csv" };
        case "external-ref":
          return { input: "link", artifactType: "external-ref" };
        default:
          return { input: "unsupported", artifactType: response.artifactType };
      }
  }
};

/** The editable value of saved work: its text, or its link. Undefined for a saved file, which is shown, not edited. */
export const editableValue = (read: ArtifactRead | undefined): string | undefined => {
  if (read === undefined) return "";
  switch (read.content.kind) {
    case "text":
      return read.content.text;
    case "external":
      return read.content.url;
    case "bytes":
      return undefined;
  }
};
