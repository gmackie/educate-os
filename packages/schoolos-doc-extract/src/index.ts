// SchoolOS document text extraction for Content Studio review (SCHO-79). See
// docs/schoolos/content-extraction.md.
//
// "Sandboxed" here means three things, each enforced by construction rather than by a runtime:
// extraction is a pure function of the document's bytes (no network, storage, clock or globals it
// writes), every loop over the document spends from a step budget so its CPU is bounded whatever
// the input, and everything it inflates or returns is capped. What it returns is untrusted data,
// which the studio passes only to the deterministic checks and an AI reviewer's data slot.
import type { ExtractableContentType, TextExtraction, TextExtractor } from "@schoolos/content-studio";
import { ExtractionStopped, StepBudget } from "./budget.ts";
import { extractDocxText } from "./docx.ts";
import { DEFAULT_EXTRACTION_LIMITS, type ExtractionLimits } from "./limits.ts";
import { extractPdfText } from "./pdf.ts";

export { DEFAULT_EXTRACTION_LIMITS, type ExtractionLimits } from "./limits.ts";

/**
 * Extracts the text of a PDF or DOCX within `limits`. Never throws for anything about the
 * document: what it cannot read exactly is `not-extractable` with a reason.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  contentType: ExtractableContentType,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): Promise<TextExtraction> {
  if (bytes.byteLength > limits.maxBytes) return { status: "not-extractable", reason: "too-large" };
  const budget = new StepBudget(limits.maxSteps);
  try {
    const { text, truncated } = contentType === "pdf"
      ? await extractPdfText(bytes, limits, budget)
      : await extractDocxText(bytes, limits, budget);
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
