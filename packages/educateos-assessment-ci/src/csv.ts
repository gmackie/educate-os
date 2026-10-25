// A metered CSV reader (RFC 4180: comma-separated, `"` quoting with `""` escapes) for evaluators.
import type { EvaluationKit, TextRange } from "./sdk.ts";
import { looseTitle } from "./text.ts";

/** One CSV record and where it is in the text. */
export interface CsvRecord {
  fields: string[];
  range: TextRange;
}

/** A column header split into its name and the unit in brackets after it: `Mass (g)` is `Mass` in `g`. */
export interface CsvColumn {
  index: number;
  header: string;
  name: string;
  unit: string | undefined;
}

/** A parsed table: its header row, its columns and its data rows. */
export interface CsvTable {
  header: CsvRecord;
  columns: CsvColumn[];
  rows: CsvRecord[];
}

/** Thrown for text that is not CSV, such as an unterminated quote. */
export class CsvSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvSyntaxError";
  }
}

/** The records of `text`, spending a step for each field. Blank lines are skipped. */
export function parseCsv(text: string, kit: EvaluationKit): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let recordStart = 0;
  let quoted = false;
  let i = 0;
  const endField = () => {
    kit.step();
    fields.push(field);
    field = "";
  };
  const endRecord = (end: number) => {
    endField();
    if (!(fields.length === 1 && fields[0]!.trim() === "") && end > recordStart) records.push({ fields, range: { start: recordStart, end } });
    fields = [];
  };
  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field.trim() === "") {
      quoted = true;
      field = "";
    } else if (char === ",") {
      endField();
    } else if (char === "\n") {
      endRecord(i);
      recordStart = i + 1;
    } else {
      field += char;
    }
    i += 1;
  }
  if (quoted) throw new CsvSyntaxError("A quoted field is never closed.");
  endRecord(text.length);
  return records;
}

const UNIT = /^(.*?)\s*[([]\s*([^()[\]]+?)\s*[)\]]\s*$/;

/** Splits a header into a name and unit. */
export function parseColumn(header: string, index: number): CsvColumn {
  const match = UNIT.exec(header.trim());
  if (match === null || match[1]!.trim() === "") return { index, header, name: header.trim(), unit: undefined };
  return { index, header, name: match[1]!.trim(), unit: match[2]! };
}

/** `text` as a table whose first record is the header, or `undefined` if it has no records. */
export function parseTable(text: string, kit: EvaluationKit): CsvTable | undefined {
  const [header, ...rows] = parseCsv(text, kit);
  if (header === undefined) return undefined;
  return { header, columns: header.fields.map((h, i) => parseColumn(h, i)), rows };
}

/** The column named `name`, compared loosely (case, spacing), ignoring its unit. */
export function findColumn(table: CsvTable, name: string): CsvColumn | undefined {
  return table.columns.find((c) => looseTitle(c.name) === looseTitle(name));
}

/** Whether two units are the same, ignoring case and spacing: `mL` and `ml` match. */
export function sameUnit(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A cell as a number, or `undefined` if it is not a plain decimal number. */
export function numericCell(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!NUMBER.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
