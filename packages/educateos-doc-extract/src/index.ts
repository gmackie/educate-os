// EducateOS document text extraction for Content Studio review (SCHO-79). See
// docs/educateos/content-extraction.md.
//
// "Sandboxed" here means three things, each enforced by construction rather than by a runtime:
// extraction is a pure function of the document's bytes (no network, storage, clock or globals it
// writes), every loop over the document spends from a step budget so its CPU is bounded whatever
// the input, and everything it inflates or returns is capped. What it returns is untrusted data,
// which the studio passes only to the deterministic checks and an AI reviewer's data slot.
import type { ExtractableContentType, TextExtraction, TextExtractor } from "@educateos/content-studio/extraction";
import { ExtractionStopped, StepBudget } from "./budget.ts";
import { extractDocxText } from "./docx.ts";
import { DEFAULT_EXTRACTION_LIMITS, type ExtractionLimits } from "./limits.ts";
import { extractPdfText } from "./pdf.ts";
import { extractPptxText } from "./pptx.ts";
import { extractCartridgeText } from "./cartridge.ts";

export { DEFAULT_EXTRACTION_LIMITS, type ExtractionLimits } from "./limits.ts";

/** Documents and read-only course packages that can supply teaching source text. */
export type DocumentContentType = ExtractableContentType | "pptx" | "cartridge";

/**
 * Extracts document text or a read-only course preview within `limits`. Never throws for anything about the
 * document: what it cannot read exactly is `not-extractable` with a reason.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  contentType: DocumentContentType,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): Promise<TextExtraction> {
  if (bytes.byteLength > limits.maxBytes) return { status: "not-extractable", reason: "too-large" };
  const budget = new StepBudget(limits.maxSteps);
  try {
    const extract = { pdf: extractPdfText, docx: extractDocxText, pptx: extractPptxText, cartridge: extractCartridgeText }[contentType];
    const { text, truncated } = await extract(bytes, limits, budget);
    if (text === "") return { status: "not-extractable", reason: "no-text" };
    return { status: "extracted", text, truncated };
  } catch (error) {
    if (error instanceof ExtractionStopped) return { status: "not-extractable", reason: error.reason };
    // A parser fault on hostile input is a malformed document, not a failure of the studio.
    return { status: "not-extractable", reason: "malformed" };
  }
}

/** A {@link TextExtractor} for the Content Studio's `extractText` option, with the given caps. */
export function documentTextExtractor(limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS): TextExtractor {
  return (bytes, contentType) => extractDocumentText(bytes, contentType, limits);
}
