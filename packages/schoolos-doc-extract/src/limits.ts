/** Caps on extracting the text of one document. */
export interface ExtractionLimits {
  /** The largest document accepted, in bytes. */
  maxBytes: number;
  /** The most pages a PDF may declare. */
  maxPages: number;
  /** The most work units extraction may spend; see `StepBudget`. */
  maxSteps: number;
  /** The most bytes all of a document's compressed parts may inflate to together. */
  maxInflatedBytes: number;
  /** The most characters of text returned; anything after is cut and marked truncated. */
  maxTextChars: number;
}

/**
 * The caps used unless a district sets its own: the Content Studio's upload cap, a long textbook
 * chapter's pages, and a step budget that a 20 MB document of ordinary text fits in comfortably.
 */
export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxBytes: 20 * 1024 * 1024,
  maxPages: 300,
  maxSteps: 20_000_000,
  maxInflatedBytes: 48 * 1024 * 1024,
  maxTextChars: 200_000,
};
