// A deterministic XLSX-to-CSV converter, so a spreadsheet submitted as an Office Open XML workbook
// is assessed by the same CSV evaluators as one submitted as text. An XLSX file is a ZIP of XML
// parts; both are read with the Common Cartridge importer's bounded readers (`@educateos/cartridge`):
// the ZIP reader caps entries, sizes and compression ratios before inflating anything, and the XML
// parser refuses any DTD or entity declaration. Nothing is evaluated: a formula cell contributes
// the value the workbook last cached for it.
import { EducateOsError } from "@educateos/contracts";
import { CartridgeRefusedError, attributeOf, childElement, childElements, parseXml, readZip, type XmlElement, type XmlLimits, type ZipLimits } from "@educateos/cartridge";

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
}

/** A workbook that could not be converted, and why. Always `validation-failed`: the file is the problem. */
export class XlsxConversionError extends EducateOsError {
  constructor(message: string) {
    super("validation-failed", `The spreadsheet could not be read: ${message}`);
    this.name = "EducateOsError";
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
  const limits = options.limits ?? DEFAULT_XLSX_LIMITS;
  let files: ReadonlyMap<string, Uint8Array>;
  try {
    ({ files } = await readZip(bytes, limits.zip));
  } catch (error) {
    if (error instanceof CartridgeRefusedError) throw new XlsxConversionError(`it is not a safe XLSX archive (${error.reason}).`);
    throw error;
  }
  const xml = (path: string): XmlElement | undefined => {
    const part = files.get(path);
    if (part === undefined) return undefined;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(part);
    } catch {
      throw new XlsxConversionError(`${path} is not UTF-8.`);
    }
    try {
      return parseXml(text, limits.xml);
    } catch (error) {
      if (error instanceof CartridgeRefusedError) throw new XlsxConversionError(`${path} is not acceptable XML (${error.reason}).`);
      throw error;
    }
  };

  const sheetPath = worksheetPath(xml, options.sheet);
  const sheet = xml(sheetPath);
  if (sheet === undefined) throw new XlsxConversionError(`the workbook names a worksheet ${sheetPath} it does not contain.`);
  const strings = sharedStrings(xml("xl/sharedStrings.xml"));
  return toCsv(readCells(sheet, strings, limits));
}

/** The path of the worksheet named `name`, or of the first sheet, through the workbook's relationships. */
function worksheetPath(xml: (path: string) => XmlElement | undefined, name: string | undefined): string {
  const workbook = xml("xl/workbook.xml");
  if (workbook === undefined) throw new XlsxConversionError("it has no workbook part.");
  const sheets = childElements(childElement(workbook, "sheets") ?? workbook, "sheet");
  const sheet = name === undefined ? sheets[0] : sheets.find((s) => attributeOf(s, "name") === name);
  if (sheet === undefined) throw new XlsxConversionError(name === undefined ? "it has no worksheets." : `it has no sheet named ${JSON.stringify(name.slice(0, 100))}.`);
  // `r:id`, whatever the workbook's prefix for the relationships namespace; `sheetId` is another attribute.
  const relationshipId = attributeOf(sheet, "id");
  const relationships = xml("xl/_rels/workbook.xml.rels");
  const relationship = relationships === undefined ? undefined : childElements(relationships, "Relationship").find((r) => attributeOf(r, "Id") === relationshipId);
  const target = relationship === undefined ? undefined : attributeOf(relationship, "Target");
  if (target === undefined) throw new XlsxConversionError("a worksheet has no part.");
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new XlsxConversionError("a worksheet's part is not a plain path inside the workbook.");
  }
  return path;
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
function readCells(sheet: XmlElement, strings: readonly string[], limits: XlsxLimits): Map<number, Map<number, string>> {
  const data = childElement(sheet, "sheetData");
  const rows = new Map<number, Map<number, string>>();
  let nextRow = 0;
  for (const row of data === undefined ? [] : childElements(data, "row")) {
    const declared = attributeOf(row, "r");
    const rowIndex = declared === undefined ? nextRow : Number(declared) - 1;
    if (!Number.isInteger(rowIndex) || rowIndex < nextRow) throw new XlsxConversionError("its rows are out of order.");
    if (rowIndex >= limits.maxRows) throw new XlsxConversionError(`it has more than ${limits.maxRows} rows.`);
    nextRow = rowIndex + 1;
    const cells = new Map<number, string>();
    let nextColumn = 0;
    for (const cell of childElements(row, "c")) {
      const reference = attributeOf(cell, "r");
      let column = nextColumn;
      if (reference !== undefined) {
        const match = CELL_REFERENCE.exec(reference);
        if (match === null || Number(match[2]) - 1 !== rowIndex) throw new XlsxConversionError(`cell ${JSON.stringify(reference.slice(0, 20))} is not in its row.`);
        column = columnIndex(match[1]!);
      }
      if (column < nextColumn) throw new XlsxConversionError("its cells are out of order.");
      if (column >= limits.maxColumns) throw new XlsxConversionError(`it has more than ${limits.maxColumns} columns.`);
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

function toCsv(rows: ReadonlyMap<number, ReadonlyMap<number, string>>): string {
  if (rows.size === 0) return "";
  let lastRow = 0;
  let width = 0;
  for (const [row, cells] of rows) {
    lastRow = Math.max(lastRow, row);
    for (const column of cells.keys()) width = Math.max(width, column + 1);
  }
  const records: string[] = [];
  for (let row = 0; row <= lastRow; row++) {
    const cells = rows.get(row);
    records.push(Array.from({ length: width }, (_, column) => csvField(cells?.get(column) ?? "")).join(","));
  }
  return records.join("\n");
}
