import { readXlsxWorkbook, XlsxConversionError } from "@educateos/assessment-ci/xlsx";
import { parseCsv } from "@educateos/integrations/csv";
import { ExtractionStopped, type StepBudget } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

/** Worksheet, row and column caps accepted for one personal lesson's spreadsheet source. */
export const LESSON_TABLE_LIMITS = { maxRows: 1000, maxColumns: 100, maxSheets: 100 } as const;

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

/** Read all worksheets in workbook order under shared lesson limits, never formula evaluation. */
export async function extractXlsxText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  try {
    const result = await readXlsxWorkbook(bytes, {
      limits: {
        zip: { maxEntries: 500, maxEntryBytes: limits.maxInflatedBytes, maxTotalBytes: limits.maxInflatedBytes, maxCompressionRatio: 100 },
        xml: { maxLength: limits.maxInflatedBytes, maxDepth: 32, maxElements: 100_000 },
        ...LESSON_TABLE_LIMITS,
      },
      maxTextChars: limits.maxTextChars,
      maxSheets: LESSON_TABLE_LIMITS.maxSheets,
      maxTotalRows: LESSON_TABLE_LIMITS.maxRows,
      spend: units => budget.spend(units),
    });
    if (!result.worksheets.some(sheet => sheet.source?.csv.trim())) throw new ExtractionStopped("no-text");
    const heading = `XLSX workbook: ${result.worksheets.length} worksheet(s). Coverage reports the values included in this excerpt.\n`;
    // Fixed-width statuses reserve exactly the final inventory length before filling values.
    const statuses: string[] = result.worksheets.map(sheet => sheet.source?.csv === "" ? "empty  " : "omitted");
    const inventory = () => result.worksheets.map((sheet, index) => `${index + 1}. ${JSON.stringify(sheet.sheetName)} (${sheet.visibility}): ${statuses[index]}`).join("\n");
    let remaining = Math.max(0, limits.maxTextChars - heading.length - inventory().length - 2);
    const sections: string[] = [];
    let truncated = result.truncated;
    for (const [index, sheet] of result.worksheets.entries()) {
      if (!sheet.source?.csv) continue;
      const label = `Worksheet ${index + 1} ${JSON.stringify(sheet.sheetName)} (${sheet.visibility}); CSV row/column values:\n`;
      const room = remaining - label.length - (sections.length ? 2 : 0);
      if (room <= 0) { truncated = true; continue; }
      const csv = sheet.source.csv.slice(0, room);
      const partial = sheet.source.truncated || csv.length < sheet.source.csv.length;
      statuses[index] = partial ? "partial" : "full   ";
      truncated ||= partial;
      sections.push(`${label}${csv}`);
      remaining -= label.length + csv.length + (sections.length > 1 ? 2 : 0);
    }
    const text = `${heading}${inventory()}\n\n${sections.join("\n\n")}`;
    return { text: text.slice(0, limits.maxTextChars), truncated: truncated || text.length > limits.maxTextChars };
  } catch (error) {
    if (error instanceof XlsxConversionError) throw new ExtractionStopped(error.reason);
    throw error;
  }
}
