// The files a student can upload, and how each is read before it is saved. Text files are saved as
// text, which the district canonicalizes and the editor can show; PDFs and pictures are saved as
// bytes, which the district checks against the type they claim and keeps in R2.
import { MAX_UPLOAD_BYTES, type UploadMediaType } from "@educateos/api-client";

/** One kind of file a step accepts. */
export type UploadFormat =
  | { encoding: "text"; mediaType: "text/plain" | "text/markdown" | "text/csv"; extensions: readonly string[]; label: string }
  | { encoding: "bytes"; mediaType: UploadMediaType; extensions: readonly string[]; label: string };

/** The formats, by short name. */
export const FORMATS = {
  text: { encoding: "text", mediaType: "text/plain", extensions: [".txt"], label: "text" },
  markdown: { encoding: "text", mediaType: "text/markdown", extensions: [".md"], label: "Markdown" },
  csv: { encoding: "text", mediaType: "text/csv", extensions: [".csv"], label: "CSV" },
  pdf: { encoding: "bytes", mediaType: "application/pdf", extensions: [".pdf"], label: "PDF" },
  png: { encoding: "bytes", mediaType: "image/png", extensions: [".png"], label: "PNG" },
  jpeg: { encoding: "bytes", mediaType: "image/jpeg", extensions: [".jpg", ".jpeg"], label: "JPEG" },
} as const satisfies Record<string, UploadFormat>;

/** The largest text file read in, well under the district's text limits. */
export const MAX_TEXT_UPLOAD_BYTES = 1024 * 1024;

/** A file read and ready to save. */
export type PickedFile =
  | { kind: "text"; name: string; mediaType: string; text: string }
  | { kind: "bytes"; name: string; mediaType: UploadMediaType; base64: string };

/** The `accept` attribute for a file input offering `formats`. */
export const acceptAttribute = (formats: readonly UploadFormat[]): string =>
  formats.flatMap((format) => [...format.extensions, format.mediaType]).join(",");

/** The formats as a student reads them, such as "PDF, PNG or JPEG". */
export const formatList = (formats: readonly UploadFormat[]): string => {
  const labels = formats.map((format) => format.label);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
};

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/**
 * Reads `file` if it is one of `formats` and within its size limit, or says why not in the
 * student's terms. The extension decides the format, since browsers report some types (Markdown,
 * CSV on Windows) inconsistently; the district checks a file's contents against its type anyway.
 */
export const readUpload = async (file: File, formats: readonly UploadFormat[]): Promise<{ file: PickedFile } | { problem: string }> => {
  const name = file.name.toLowerCase();
  const format = formats.find((f) => f.extensions.some((extension) => name.endsWith(extension)));
  if (format === undefined) return { problem: `Choose a ${formatList(formats)} file.` };
  const limit = format.encoding === "text" ? MAX_TEXT_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
  if (file.size > limit) return { problem: `That file is too big. Choose one under ${megabytes(limit)}.` };
  if (format.encoding === "text") return { file: { kind: "text", name: file.name, mediaType: format.mediaType, text: await file.text() } };
  return { file: { kind: "bytes", name: file.name, mediaType: format.mediaType, base64: toBase64(new Uint8Array(await file.arrayBuffer())) } };
};
