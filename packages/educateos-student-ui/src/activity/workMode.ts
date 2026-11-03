import type { ActivityStep, ArtifactRead, ArtifactType } from "../model.ts";
import { FORMATS, type UploadFormat } from "./uploadFormats.ts";

/** A dataset column a lab step asks for. */
export type DatasetColumn = Extract<ActivityStep["response"], { kind: "dataset" }>["columns"][number];

/**
 * How the student produces a step's work, and what it is saved as:
 * - `writing`: typed text, saved as a plain-text document.
 * - `dataset`: a table of observations, saved as CSV.
 * - `upload`: a CSV file from the device, saved as its text and shown as a table.
 * - `file`: a file from the device, saved as soon as it is chosen: a text file as text, a PDF or
 *   picture as the file itself.
 * - `picture`: a picture drawn on the drawing pad or a photo from the device, saved as soon as it
 *   is done. Offered where young learners draw; elsewhere a picture is a `file`.
 * - `recording`: the student's voice, recorded in the browser or uploaded, saved when they choose.
 * - `link`: a link to work kept in the school's approved document service.
 * - `unsupported`: a file kind the district API cannot take yet (video, notebooks).
 */
export type WorkMode =
  | { input: "writing"; artifactType: "document"; mediaType: "text/plain" }
  | { input: "dataset"; artifactType: "dataset"; mediaType: "text/csv"; columns: DatasetColumn[] }
  | { input: "upload"; artifactType: ArtifactType; mediaType: "text/csv"; formats: readonly UploadFormat[] }
  | { input: "file"; artifactType: ArtifactType; formats: readonly UploadFormat[] }
  | { input: "picture"; artifactType: ArtifactType; formats: readonly UploadFormat[] }
  | { input: "recording"; artifactType: ArtifactType; formats: readonly UploadFormat[] }
  | { input: "link"; artifactType: "external-ref" }
  | { input: "unsupported"; artifactType: ArtifactType };

/** The kinds of work that are saved as soon as they are made, rather than edited and then saved. */
export type CapturedWorkMode = Extract<WorkMode, { input: "file" | "picture" | "recording" }>;

/** Whether work is made and saved in one go: a file, a picture or a recording. */
export const isCaptured = (mode: WorkMode): mode is CapturedWorkMode =>
  mode.input === "file" || mode.input === "picture" || mode.input === "recording";

const RECORDING_FORMATS = [FORMATS.m4a, FORMATS.mp3, FORMATS.wav, FORMATS.webm, FORMATS.ogg];

/**
 * The way a step's work is produced, or undefined for a step that produces nothing. `drawing`
 * offers the drawing pad for a picture, which the classes that draw get.
 */
export const workModeFor = (step: ActivityStep, { drawing = false }: { drawing?: boolean } = {}): WorkMode | undefined => {
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
          return { input: "file", artifactType: "document", formats: [FORMATS.pdf, FORMATS.text, FORMATS.markdown] };
        case "image":
          return { input: drawing ? "picture" : "file", artifactType: "image", formats: [FORMATS.png, FORMATS.jpeg] };
        case "audio":
          return { input: "recording", artifactType: "audio", formats: RECORDING_FORMATS };
        case "presentation":
          return { input: "file", artifactType: "presentation", formats: [FORMATS.pdf] };
        case "evidence":
        case "portfolio":
          return { input: "file", artifactType: response.artifactType, formats: [FORMATS.pdf, FORMATS.png, FORMATS.jpeg, FORMATS.text] };
        case "dataset":
        case "spreadsheet":
          return { input: "upload", artifactType: response.artifactType, mediaType: "text/csv", formats: [FORMATS.csv] };
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
