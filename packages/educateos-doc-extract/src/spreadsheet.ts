import { readXlsxWorksheet, XlsxConversionError } from "@educateos/assessment-ci/xlsx";
import { parseCsv } from "@educateos/integrations/csv";
import { ExtractionStopped, type StepBudget } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

/** Rows and columns accepted for one personal lesson's spreadsheet source. */
export const LESSON_TABLE_LIMITS = { maxRows: 1000, maxColumns: 100 } as const;

const excerpt = (heading: string, csv: string, maxChars: number, truncated = false) => {
  if (!csv.trim()) throw new ExtractionStopped("no-text");
  const text = `${heading}\n${csv}`;
  return { text: text.slice(0, maxChars), truncated: truncated || text.length > maxChars };
};

/** Validate UTF-8 comma-separated source data without interpreting or evaluating any cell. */
export async function extractCsvText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  budget.spend(bytes.byteLength);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ExtractionStopped("unsupported-encoding");
  }
  // CSV permits tabs and line endings, but binary control bytes are not teaching source text.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new ExtractionStopped("unsupported-encoding");
  const result = parseCsv(text, { maxRows: LESSON_TABLE_LIMITS.maxRows - 1, maxColumns: LESSON_TABLE_LIMITS.maxColumns, spend: units => budget.spend(units) });
  if (!result.ok) throw new ExtractionStopped(result.error.reason === "syntax" ? "malformed" : "too-large");
  if (!result.records.some(record => record.fields.some(field => field.trim() !== ""))) throw new ExtractionStopped("no-text");
  return excerpt("CSV source; rows and columns are comma-separated, with quoted multiline cells preserved.", text, limits.maxTextChars);
}

/** Use the existing bounded workbook converter for a first-sheet CSV excerpt, never formula evaluation. */
export async function extractXlsxText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  try {
    const result = await readXlsxWorksheet(bytes, {
      limits: {
        zip: { maxEntries: 500, maxEntryBytes: limits.maxInflatedBytes, maxTotalBytes: limits.maxInflatedBytes, maxCompressionRatio: 100 },
        xml: { maxLength: limits.maxInflatedBytes, maxDepth: 32, maxElements: 100_000 },
        ...LESSON_TABLE_LIMITS,
      },
      maxTextChars: limits.maxTextChars,
      spend: units => budget.spend(units),
    });
    return excerpt(`First worksheet ${JSON.stringify(result.sheetName)} only; values in CSV row/column order. Other worksheets are omitted.`, result.csv, limits.maxTextChars, result.truncated);
  } catch (error) {
    if (error instanceof XlsxConversionError) throw new ExtractionStopped(error.reason);
    throw error;
  }
}
