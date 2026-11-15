// A deterministic XLSX-to-CSV converter, so a spreadsheet submitted as an Office Open XML workbook
// is assessed by the same CSV evaluators as one submitted as text. An XLSX file is a ZIP of XML
// parts; both are read with the Common Cartridge importer's bounded readers (`@educateos/cartridge`):
// the ZIP reader caps entries, sizes and compression ratios before inflating anything, and the XML
// parser refuses any DTD or entity declaration. Nothing is evaluated: a formula cell contributes
// the value the workbook last cached for it.
import { EducateOsError } from "@educateos/contracts";
import { CartridgeRefusedError } from "@educateos/cartridge/errors";
import { attributeOf, childElement, childElements, parseXml, type XmlElement, type XmlLimits } from "@educateos/cartridge/xml";
import { readZip, type ZipLimits } from "@educateos/cartridge/zip";

/** The media type of an XLSX workbook. */
export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Caps on what converting one workbook may cost. */
export interface XlsxLimits {
  zip: ZipLimits;
  xml: XmlLimits;
  /** The most rows the CSV may have. */
  maxRows: number;
  /** The most columns the CSV may have. */
  maxColumns: number;
}

/** Ample for a class dataset, and far below what a Worker can hold. */
export const DEFAULT_XLSX_LIMITS: XlsxLimits = {
  zip: { maxEntries: 500, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024, maxCompressionRatio: 100 },
  xml: { maxLength: 16 * 1024 * 1024, maxDepth: 32, maxElements: 1_000_000 },
  maxRows: 50_000,
  maxColumns: 500,
};

/** What converting a workbook takes. */
export interface XlsxToCsvOptions {
  /** The worksheet to convert, by name. Defaults to the workbook's first sheet. */
  sheet?: string;
  limits?: XlsxLimits;
  /** Charges XML, cells and output to a caller-owned work budget; never observes source contents. */
  spend?: (units: number) => void;
}

/** A workbook that could not be converted, and why. Always `validation-failed`: the file is the problem. */
export class XlsxConversionError extends EducateOsError {
  /** A stable refusal category for source-preview consumers. */
  readonly reason: "malformed" | "too-large" | "unsupported-encoding";

  constructor(message: string, reason: XlsxConversionError["reason"] = "malformed") {
    super("validation-failed", `The spreadsheet could not be read: ${message}`);
    this.name = "EducateOsError";
    this.reason = reason;
  }
}

/**
 * Converts one worksheet of an XLSX workbook to canonical CSV text: one record per row from the
 * first row to the last that has a cell, each with as many fields as the sheet's widest row, empty
 * fields for empty cells, records separated by `\n`, and a field quoted (with `""` for `"`) only
 * when it holds a comma, quote or line break. Cell values are read without styles: shared and
 * inline strings as written, booleans as `TRUE`/`FALSE`, errors as their code (`#DIV/0!`), and
 * numbers in JavaScript's shortest form, so a date is its serial number. The same bytes always give
 * the same text.
 *
 * @throws XlsxConversionError for a file that is not a readable workbook, breaks a limit, or lacks the sheet.
 */
export async function xlsxToCsv(bytes: Uint8Array, options: XlsxToCsvOptions = {}): Promise<string> {
  return (await readXlsxWorksheet(bytes, options)).csv;
}

/** A bounded first/named-sheet projection; hidden cells are included and formulas use cached values. */
export interface XlsxWorksheetPreview {
  sheetName: string;
  csv: string;
  truncated: boolean;
}

/** Read a worksheet without evaluating formulas or fetching relationships; optionally cap its CSV excerpt. */
export async function readXlsxWorksheet(bytes: Uint8Array, options: XlsxToCsvOptions & { maxTextChars?: number } = {}): Promise<XlsxWorksheetPreview> {
  const limits = options.limits ?? DEFAULT_XLSX_LIMITS;
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    ({ files } = await readZip(bytes, limits.zip));
  } catch (error) {
    if (error instanceof CartridgeRefusedError) throw new XlsxConversionError(`it is not a safe XLSX archive (${error.reason}).`, ["too-many-entries", "entry-too-large", "package-too-large", "compression-ratio"].includes(error.reason) ? "too-large" : "malformed");
    throw error;
  }
  const xml = (path: string): XmlElement | undefined => {
    const part = files.get(path);
    if (part === undefined) return undefined;
    options.spend?.(part.byteLength);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(part);
    } catch {
      throw new XlsxConversionError(`${path} is not UTF-8.`, "unsupported-encoding");
    }
    try {
      return parseXml(text, limits.xml);
    } catch (error) {
      if (error instanceof CartridgeRefusedError) throw new XlsxConversionError(`${path} is not acceptable XML (${error.reason}).`, error.reason === "xml-too-large" ? "too-large" : "malformed");
      throw error;
    }
  };

  const { path, name } = worksheetPath(xml, options.sheet);
  const sheet = xml(path);
  if (sheet?.namespace !== MAIN || sheet.local !== "worksheet") throw new XlsxConversionError("the selected worksheet part is missing or invalid.");
  const strings = sharedStrings(xml("xl/sharedStrings.xml"));
  return { sheetName: name, ...toCsv(readCells(sheet, strings, limits, options.spend), options.maxTextChars, options.spend) };
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** The path of the worksheet named `name`, or of the first sheet, through the workbook's relationships. */
function worksheetPath(xml: (path: string) => XmlElement | undefined, name: string | undefined): { path: string; name: string } {
  const workbook = xml("xl/workbook.xml");
  if (workbook?.namespace !== MAIN || workbook.local !== "workbook") throw new XlsxConversionError("it has no workbook part.");
  const sheets = childElements(childElement(workbook, "sheets") ?? workbook, "sheet");
  const sheet = name === undefined ? sheets[0] : sheets.find((s) => attributeOf(s, "name") === name);
  if (sheet === undefined) throw new XlsxConversionError(name === undefined ? "it has no worksheets." : `it has no sheet named ${JSON.stringify(name.slice(0, 100))}.`);
  // `r:id`, whatever the workbook's prefix for the relationships namespace; `sheetId` is another attribute.
  const relationshipId = attributeOf(sheet, "id");
  const relationships = xml("xl/_rels/workbook.xml.rels");
  const relationship = relationships?.namespace !== PACKAGE_RELS ? undefined : childElements(relationships, "Relationship").find((r) => attributeOf(r, "Id") === relationshipId);
  if (relationship === undefined || attributeOf(relationship, "Type") !== `${RELS}/worksheet` ||
      attributeOf(relationship, "TargetMode") !== undefined && attributeOf(relationship, "TargetMode") !== "Internal") {
    throw new XlsxConversionError("a worksheet relationship is missing, external or unsupported.");
  }
  const target = attributeOf(relationship, "Target");
  if (target === undefined) throw new XlsxConversionError("a worksheet has no part.");
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  if (!/^xl\/worksheets\/[^/\\?#%]+\.xml$/.test(path)) {
    throw new XlsxConversionError("a worksheet's part is not a plain path inside the workbook.");
  }
  return { path, name: attributeOf(sheet, "name") ?? "Unnamed worksheet" };
}

/** The text of an `<si>` or `<is>`: its own `<t>`, or its rich-text runs' `<t>` joined, as written. */
function stringItemText(item: XmlElement): string {
  const own = childElement(item, "t");
  if (own !== undefined) return rawText(own);
  return childElements(item, "r").map((run) => rawText(childElement(run, "t"))).join("");
}

/** An element's character data exactly as written, without the whitespace folding `textOf` does. */
function rawText(element: XmlElement | undefined): string {
  if (element === undefined) return "";
  return element.children.map((node) => (typeof node === "string" ? node : rawText(node))).join("");
}

function sharedStrings(table: XmlElement | undefined): string[] {
  return table === undefined ? [] : childElements(table, "si").map(stringItemText);
}

const CELL_REFERENCE = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

/** A column's zero-based index from its letters: `A` is 0, `Z` 25, `AA` 26. */
function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** The sheet's cells as rows of strings, rows and columns zero-based and possibly sparse. */
function readCells(sheet: XmlElement, strings: readonly string[], limits: XlsxLimits, spend?: (units: number) => void): Map<number, Map<number, string>> {
  const data = childElement(sheet, "sheetData");
  const rows = new Map<number, Map<number, string>>();
  let nextRow = 0;
  for (const row of data === undefined ? [] : childElements(data, "row")) {
    spend?.(1);
    const declared = attributeOf(row, "r");
    const rowIndex = declared === undefined ? nextRow : Number(declared) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < nextRow) throw new XlsxConversionError("its rows are out of order.");
    if (rowIndex >= limits.maxRows) throw new XlsxConversionError(`it has more than ${limits.maxRows} rows.`, "too-large");
    nextRow = rowIndex + 1;
    const cells = new Map<number, string>();
    let nextColumn = 0;
    for (const cell of childElements(row, "c")) {
      spend?.(1);
      const reference = attributeOf(cell, "r");
      let column = nextColumn;
      if (reference !== undefined) {
        const match = CELL_REFERENCE.exec(reference);
        if (match === null || Number(match[2]) - 1 !== rowIndex) throw new XlsxConversionError(`cell ${JSON.stringify(reference.slice(0, 20))} is not in its row.`);
        column = columnIndex(match[1]!);
      }
      if (column < nextColumn) throw new XlsxConversionError("its cells are out of order.");
      if (column >= limits.maxColumns) throw new XlsxConversionError(`it has more than ${limits.maxColumns} columns.`, "too-large");
      nextColumn = column + 1;
      const value = cellValue(cell, strings);
      if (value !== "") cells.set(column, value);
    }
    if (cells.size > 0) rows.set(rowIndex, cells);
  }
  return rows;
}

function cellValue(cell: XmlElement, strings: readonly string[]): string {
  const type = attributeOf(cell, "t") ?? "n";
  const value = rawText(childElement(cell, "v"));
  switch (type) {
    case "s": {
      // A missing cached formula value must not become a reference to shared string zero.
      if (value.trim() === "") return "";
      const index = Number(value);
      const text = Number.isInteger(index) ? strings[index] : undefined;
      if (text === undefined) throw new XlsxConversionError("a cell names a shared string the workbook does not have.");
      return text;
    }
    case "inlineStr": {
      const inline = childElement(cell, "is");
      return inline === undefined ? "" : stringItemText(inline);
    }
    case "str":
    case "e":
      return value;
    case "b":
      return value === "1" ? "TRUE" : value === "0" ? "FALSE" : "";
    case "n": {
      if (value.trim() === "") return "";
      const number = Number(value);
      if (!Number.isFinite(number)) throw new XlsxConversionError("a numeric cell does not hold a number.");
      return String(number);
    }
    default:
      throw new XlsxConversionError(`a cell has the unknown type ${JSON.stringify(type.slice(0, 20))}.`);
  }
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function toCsv(rows: ReadonlyMap<number, ReadonlyMap<number, string>>, maxChars = Infinity, spend?: (units: number) => void): { csv: string; truncated: boolean } {
  if (rows.size === 0) return { csv: "", truncated: false };
  let lastRow = 0;
  let width = 0;
  for (const [row, cells] of rows) {
    spend?.(1);
    lastRow = Math.max(lastRow, row);
    for (const column of cells.keys()) { spend?.(1); width = Math.max(width, column + 1); }
  }
  const parts: string[] = [];
  let length = 0;
  const write = (text: string) => {
    const room = Math.max(0, maxChars - length);
    parts.push(text.slice(0, room));
    length += Math.min(room, text.length);
    return text.length <= room;
  };
  for (let row = 0; row <= lastRow; row++) {
    if (row > 0 && !write("\n")) return { csv: parts.join(""), truncated: true };
    const cells = rows.get(row);
    for (let column = 0; column < width; column++) {
      const value = cells?.get(column) ?? "";
      spend?.(1 + value.length);
      if (column > 0 && !write(",") || !write(csvField(value))) return { csv: parts.join(""), truncated: true };
    }
  }
  return { csv: parts.join(""), truncated: false };
}
