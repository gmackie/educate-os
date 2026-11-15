import { extractDocumentText, type DocumentContentType } from "./index.ts";
import type { ExtractionLimits } from "./limits.ts";
import type { TextExtraction } from "@educateos/content-studio/extraction";

/** A file's declared type and name are parser hints, never proof of its contents. */
export type LessonSourceFile = { mimeType: string; name?: string };

/** Shared caps for a personal lesson's local preview and chat replay. */
export const LESSON_SOURCE_LIMITS: Readonly<ExtractionLimits> = {
  maxBytes: 4 * 1024 * 1024,
  maxInflatedBytes: 2 * 1024 * 1024,
  maxSteps: 2_000_000,
  maxPages: 100,
  maxTextChars: 32 * 1024,
};

/** Select a bounded reader; that reader still checks the actual document structure. */
export const lessonSourceType = (file: LessonSourceFile): DocumentContentType | undefined => {
  const generic = file.mimeType === "application/octet-stream";
  if (file.mimeType === "application/pdf" || generic && /\.pdf$/i.test(file.name ?? "")) return "pdf";
  if (file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      generic && /\.docx$/i.test(file.name ?? "")) return "docx";
  if (file.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      generic && /\.pptx$/i.test(file.name ?? "")) return "pptx";
  if (/\.(imscc|zip)$/i.test(file.name ?? "") && ["application/zip", "application/x-zip-compressed",
    "application/vnd.ims.imsccv1p3", "application/vnd.ims.imsccv1p2", "application/vnd.ims.imsccv1p1",
    "application/octet-stream"].includes(file.mimeType)) return "cartridge";
  return undefined;
};

/** The local text check's result; unsupported originals can still use other model input paths. */
export type LessonSourceReview =
  | { status: "unsupported" }
  | { status: "reviewed"; type: DocumentContentType; extraction: TextExtraction };

/** Read a lesson under the same caps in the browser and backend, without modifying the original. */
export const reviewLessonSource = async (
  file: LessonSourceFile,
  bytes: Uint8Array,
  maxTextChars = LESSON_SOURCE_LIMITS.maxTextChars,
): Promise<LessonSourceReview> => {
  const type = lessonSourceType(file);
  if (!type) return { status: "unsupported" };
  const extraction = await extractDocumentText(bytes, type, { ...LESSON_SOURCE_LIMITS, maxTextChars });
  return { status: "reviewed", type, extraction };
};
