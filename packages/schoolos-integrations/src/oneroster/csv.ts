// An RFC 4180 CSV reader. New for SchoolOS: PlayTrek's OneRoster adapter only spoke REST.

/** One CSV record: its fields and where it sits in the file. */
export interface CsvRecord {
  /** The record's 1-based position, counting the header as row 1. Blank lines are not counted. */
  row: number;
  /** The 1-based line the record starts on. It differs from `row` once a quoted field spans lines. */
  line: number;
  /** The record's fields, unquoted and unescaped. */
  fields: string[];
}

/** Why a CSV document could not be read. Parsing stops at the first such error. */
export interface CsvSyntaxError {
  /** The row the error is in, numbered as {@link CsvRecord.row}. */
  row: number;
  /** The line the error is on. */
  line: number;
  /** What is wrong. */
  message: string;
}

/** The outcome of {@link parseCsv}: every record including the header, or the first syntax error. */
export type CsvParseResult =
  | { ok: true; records: CsvRecord[] }
  | { ok: false; error: CsvSyntaxError };

/**
 * Reads an RFC 4180 document: comma-separated fields, records ending in CRLF (LF alone is also
 * accepted), and double-quoted fields that may hold commas, line breaks and `""` escapes. A leading
 * byte order mark is skipped, as are empty lines.
 *
 * It is strict where leniency would guess at the author's meaning: a quote inside an unquoted
 * field, text after a closing quote, a bare carriage return and an unterminated quoted field are all
 * errors. Reading stops once `maxRows` records follow the header, so an oversized file costs no
 * more than the cap.
 */
export function parseCsv(text: string, options: { maxRows: number }): CsvParseResult {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  // Whether the current record has any content, so that an empty line is skipped while `""` (one
  // empty quoted field) is still a record.
  let started = false;
  let quoted = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const fail = (message: string, at = line): CsvParseResult => ({
    ok: false,
    error: { row: records.length + 1, line: at, message },
  });

  const endRecord = (): CsvParseResult | undefined => {
    if (started) {
      fields.push(field);
      if (records.length > options.maxRows) {
        return fail(`has more than ${options.maxRows} data rows`, recordLine);
      }
      records.push({ row: records.length + 1, line: recordLine, fields });
    }
    fields = [];
    field = "";
    started = false;
    afterQuote = false;
    return undefined;
  };

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }

    if (c === ",") {
      fields.push(field);
      field = "";
      started = true;
      afterQuote = false;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r") {
        if (text[i + 1] !== "\n") return fail("has a carriage return that is not followed by a line feed");
        i++;
      }
      const failure = endRecord();
      if (failure) return failure;
      line++;
      recordLine = line;
    } else if (afterQuote) {
      return fail("has text after a closing quote; quote the whole field");
    } else if (c === '"') {
      if (field !== "") return fail("has a quote inside an unquoted field; quote the field and double the quote");
      quoted = true;
      started = true;
      quoteLine = line;
    } else {
      field += c;
      started = true;
    }
  }

  if (quoted) return fail("has a quoted field that is never closed", quoteLine);
  const failure = endRecord();
  if (failure) return failure;
  return { ok: true, records };
}
