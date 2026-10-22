import type { ContentType } from "./sniff.ts";

/** The content types a {@link TextExtractor} is asked about: those the studio cannot read as text itself. */
export type ExtractableContentType = Extract<ContentType, "pdf" | "docx">;

/** Why a document yielded no text for review. Each is a rule, never a detail of the document. */
export type NotExtractableReason =
  /** The text is drawn with font encodings or stream filters the extractor does not decode. */
  | "unsupported-encoding"
  | "encrypted"
  | "too-many-pages"
  /** The document, or what it inflates to, is over a size cap. */
  | "too-large"
  /** Extraction would take more steps than its budget allows. */
  | "budget-exceeded"
  | "malformed"
  /** The document holds no text, such as a scanned image. */
  | "no-text";

/** Every {@link NotExtractableReason}, so an injected extractor's answer can be checked. */
export const NOT_EXTRACTABLE_REASONS: readonly NotExtractableReason[] = [
  "unsupported-encoding",
  "encrypted",
  "too-many-pages",
  "too-large",
  "budget-exceeded",
  "malformed",
  "no-text",
];

/**
 * What text extraction produced. The text is untrusted data: the studio passes it to the
 * deterministic checks and to an AI reviewer's data slot, and stores only its length.
 */
export type TextExtraction =
  | { status: "extracted"; text: string; truncated: boolean }
  | { status: "not-extractable"; reason: NotExtractableReason };

/**
 * Extracts the text of a PDF or DOCX for review. It must behave as a pure function of its input:
 * no network, no storage, and bounded work. `@schoolos/doc-extract` is the implementation SchoolOS
 * ships. Throwing is treated as `malformed`.
 */
export type TextExtractor = (bytes: Uint8Array, contentType: ExtractableContentType) => Promise<TextExtraction>;

/** What an item records about extraction: the outcome and how much text there was, never the text. */
export type ExtractionRecord =
  | { status: "extracted"; characters: number; truncated: boolean }
  | { status: "not-extractable"; reason: NotExtractableReason }
  | { status: "not-configured" };

/** The most extracted text the studio keeps in memory for review, in UTF-16 code units. */
export const MAX_EXTRACTED_TEXT = 200_000;

/**
 * Runs `extractor` on a document and normalizes its answer: a thrown error or a malformed result
 * becomes `malformed`, and text over {@link MAX_EXTRACTED_TEXT} is cut and marked truncated.
 */
export async function extractForReview(
  extractor: TextExtractor | undefined,
  bytes: Uint8Array,
  contentType: ExtractableContentType,
): Promise<{ record: ExtractionRecord; text: string | undefined }> {
  if (extractor === undefined) return { record: { status: "not-configured" }, text: undefined };
  let result: TextExtraction;
  try {
    result = await extractor(bytes, contentType);
  } catch {
    return { record: { status: "not-extractable", reason: "malformed" }, text: undefined };
  }
  if (result?.status === "extracted" && typeof result.text === "string") {
    const truncated = result.truncated === true || result.text.length > MAX_EXTRACTED_TEXT;
    const text = result.text.slice(0, MAX_EXTRACTED_TEXT);
    return { record: { status: "extracted", characters: text.length, truncated }, text };
  }
  const reason = result?.status === "not-extractable" && NOT_EXTRACTABLE_REASONS.includes(result.reason) ? result.reason : "malformed";
  return { record: { status: "not-extractable", reason }, text: undefined };
}
