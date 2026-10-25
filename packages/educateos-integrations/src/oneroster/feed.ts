// Reads a OneRoster 1.2 bulk CSV export into validated rows. New for EducateOS.
import { z } from "zod";
import { parseCsv } from "./csv.ts";
import { ONEROSTER_FILES, ONEROSTER_HEADERS, ROW_SCHEMAS } from "./spec.ts";
import type { OneRosterFile, OneRosterRow } from "./spec.ts";

/** One problem found while reading or mapping a feed. */
export interface OneRosterIssue {
  /** An `error` blocks apply. A `warning` reports something skipped on purpose. */
  severity: "error" | "warning";
  /** The file the problem is in, when it is in one. */
  file?: OneRosterFile | "manifest.csv";
  /**
   * The 1-based row, counting the header as row 1. A feed read over REST has no header: its rows
   * are numbered from 1 in the order the feed lists them.
   */
  row?: number;
  /** The `sourcedId` of the record the problem is in, when it has one. */
  sourcedId?: string;
  /** The column, when the problem is in one field. */
  column?: string;
  /** What is wrong, safe to show a district administrator. */
  message: string;
}

/** Size limits on each file read. A file over either limit is rejected whole. */
export interface OneRosterCsvLimits {
  /** The largest file accepted, in bytes of UTF-8. */
  maxFileBytes: number;
  /** The most data rows accepted in one file, not counting the header. */
  maxRowsPerFile: number;
}

/** Limits generous enough for a large district's bulk export. */
export const DEFAULT_CSV_LIMITS: OneRosterCsvLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxRowsPerFile: 500_000,
};

/** The validated rows of every file EducateOS reads. Rows that failed validation are left out. */
export type OneRosterFeed = { [F in OneRosterFile]: OneRosterRow<F>[] };

/**
 * The latest `dateLastModified` a feed lists in each file, as ISO 8601 UTC: where a delta of that
 * file's records can start. A file whose records list none has no entry.
 */
export type OneRosterHighWater = Partial<Record<OneRosterFile, string>>;

/** A bulk export as uploaded: file contents keyed by file name, such as `users.csv`. */
export type OneRosterCsvFiles = Readonly<Record<string, string | Uint8Array>>;

// Past this many issues the rest are summarized, so a badly broken file yields a readable report.
const MAX_ISSUES = 1000;
// A manifest lists one property per row; the specification defines a few dozen.
const MANIFEST_MAX_ROWS = 1000;

/**
 * Reads a bulk export: checks `manifest.csv`, then each file's header and rows against the
 * specification. Every problem is returned as an issue rather than thrown, so a preview can show
 * them all; the feed holds only the rows that validated.
 *
 * It also reports each file's latest `dateLastModified`, so a REST delta can follow a CSV import.
 * A blank date is allowed (bulk files may omit it); one that is not a date and time is a warning
 * and is left out of the high-water mark, which can only make a later delta read more.
 *
 * Only {@link ONEROSTER_FILES} are opened. Every other file in the export is ignored unread, and
 * `demographics.csv` in particular is never decoded, size-checked or parsed: EducateOS has no use for
 * it and it is the most sensitive file in an export.
 */
export function readOneRosterCsv(
  files: OneRosterCsvFiles,
  limits: OneRosterCsvLimits = DEFAULT_CSV_LIMITS,
): { feed: OneRosterFeed; issues: OneRosterIssue[]; highWater: OneRosterHighWater } {
  const issues: OneRosterIssue[] = [];
  const readable = readManifest(files, limits, issues);
  const feed = {} as Record<OneRosterFile, unknown[]>;
  const highWater: OneRosterHighWater = {};
  for (const file of ONEROSTER_FILES) {
    const read = readable ? readFile(file, files, limits, issues) : undefined;
    feed[file] = read?.rows ?? [];
    if (read?.highWater !== undefined) highWater[file] = new Date(read.highWater).toISOString();
  }

  if (issues.length > MAX_ISSUES) {
    const errors = issues.filter((issue) => issue.severity === "error").length;
    issues.splice(MAX_ISSUES, Infinity, {
      severity: "error",
      message: `${issues.length - MAX_ISSUES} more issues not shown (${errors} errors in total)`,
    });
  }
  return { feed: feed as OneRosterFeed, issues, highWater };
}

/** Reads a file's text, enforcing the byte limit before decoding. */
function readText(
  file: OneRosterFile | "manifest.csv",
  files: OneRosterCsvFiles,
  limits: OneRosterCsvLimits,
  issues: OneRosterIssue[],
): string | undefined {
  const content = Object.hasOwn(files, file) ? files[file] : undefined;
  if (content === undefined) {
    issues.push({ severity: "error", file, message: "is missing from the export" });
    return undefined;
  }
  // A UTF-16 code unit is at least one UTF-8 byte, so a string longer than the limit is over it.
  const tooLarge = typeof content === "string"
    ? content.length > limits.maxFileBytes || new TextEncoder().encode(content).byteLength > limits.maxFileBytes
    : content.byteLength > limits.maxFileBytes;
  if (tooLarge) {
    issues.push({ severity: "error", file, message: `is larger than ${limits.maxFileBytes} bytes` });
    return undefined;
  }
  if (typeof content === "string") return content;
  try {
    // `ignoreBOM` keeps a byte order mark in the text, where the CSV reader skips it either way.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    issues.push({ severity: "error", file, message: "is not valid UTF-8" });
    return undefined;
  }
}

/**
 * Checks that the manifest declares OneRoster 1.2 and a bulk copy of every file EducateOS reads.
 * Returns false when the export cannot be read at all.
 */
function readManifest(files: OneRosterCsvFiles, limits: OneRosterCsvLimits, issues: OneRosterIssue[]): boolean {
  const file = "manifest.csv";
  const text = readText(file, files, limits, issues);
  if (text === undefined) return false;
  const parsed = parseCsv(text, { maxRows: MANIFEST_MAX_ROWS });
  if (!parsed.ok) {
    issues.push({ severity: "error", file, row: parsed.error.row, message: parsed.error.message });
    return false;
  }
  const [header, ...rows] = parsed.records;
  if (header?.fields.join(",") !== "propertyName,value") {
    issues.push({ severity: "error", file, row: 1, message: "header must be propertyName,value" });
    return false;
  }
  const properties = new Map<string, string>();
  for (const record of rows) {
    const [name, value] = record.fields;
    if (record.fields.length !== 2 || name === undefined || value === undefined) {
      issues.push({ severity: "error", file, row: record.row, message: `has ${record.fields.length} fields; expected 2` });
    } else if (properties.has(name)) {
      issues.push({ severity: "error", file, row: record.row, column: "propertyName", message: `repeats ${name}` });
    } else {
      properties.set(name, value);
    }
  }

  const before = issues.length;
  const expect = (name: string, expected: string) => {
    const value = properties.get(name);
    if (value !== expected) {
      issues.push({
        severity: "error",
        file,
        message: value === undefined ? `does not set ${name}` : `sets ${name} to ${value}; expected ${expected}`,
      });
    }
  };
  expect("manifest.version", "1.0");
  expect("oneroster.version", "1.2");
  for (const name of ONEROSTER_FILES) {
    const mode = properties.get(`file.${name.replace(/\.csv$/, "")}`);
    if (mode === "delta") {
      issues.push({ severity: "error", file, message: `declares ${name} as a delta; EducateOS imports bulk exports only` });
    } else if (mode !== "bulk") {
      issues.push({ severity: "error", file, message: `must declare ${name} as bulk` });
    }
  }
  return issues.length === before;
}

const ModifiedAt = z.iso.datetime({ offset: true });

/**
 * Reads one file's header and rows, and the latest `dateLastModified` among the rows read, in
 * epoch milliseconds. Returns undefined when the file cannot be read at all.
 */
function readFile(
  file: OneRosterFile,
  files: OneRosterCsvFiles,
  limits: OneRosterCsvLimits,
  issues: OneRosterIssue[],
): { rows: Record<string, unknown>[]; highWater?: number } | undefined {
  const text = readText(file, files, limits, issues);
  if (text === undefined) return undefined;
  const parsed = parseCsv(text, { maxRows: limits.maxRowsPerFile });
  if (!parsed.ok) {
    issues.push({ severity: "error", file, row: parsed.error.row, message: `line ${parsed.error.line} ${parsed.error.message}` });
    return undefined;
  }
  const [header, ...records] = parsed.records;
  if (header === undefined) {
    issues.push({ severity: "error", file, message: "is empty; expected at least a header row" });
    return undefined;
  }

  const spec = ONEROSTER_HEADERS[file];
  const before = issues.length;
  const seen = new Set<string>();
  for (const column of header.fields) {
    if (seen.has(column)) issues.push({ severity: "error", file, row: 1, column, message: "appears twice in the header" });
    else if (!spec.includes(column) && !column.startsWith("metadata.")) {
      issues.push({ severity: "error", file, row: 1, column, message: "is not a OneRoster 1.2 column" });
    }
    seen.add(column);
  }
  for (const column of spec) {
    if (!seen.has(column)) issues.push({ severity: "error", file, row: 1, column, message: "is missing from the header" });
  }
  if (issues.length > before) return undefined;

  const schema: z.ZodObject = ROW_SCHEMAS[file];
  const read = Object.keys(schema.shape).map((column) => [column, header.fields.indexOf(column)] as const);
  const modifiedColumn = header.fields.indexOf("dateLastModified");
  const rows: Record<string, unknown>[] = [];
  let highWater: number | undefined;
  const sourcedIds = new Set<string>();
  for (const record of records) {
    if (record.fields.length !== header.fields.length) {
      issues.push({
        severity: "error",
        file,
        row: record.row,
        message: `has ${record.fields.length} fields; the header has ${header.fields.length}`,
      });
      continue;
    }
    const result = schema.safeParse(Object.fromEntries(read.map(([column, index]) => [column, record.fields[index]])));
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({ severity: "error", file, row: record.row, column: String(issue.path[0]), message: issue.message });
      }
      continue;
    }
    const value = result.data;
    if (typeof value.sourcedId === "string") {
      if (sourcedIds.has(value.sourcedId)) {
        issues.push({ severity: "error", file, row: record.row, column: "sourcedId", message: `repeats ${value.sourcedId}` });
        continue;
      }
      sourcedIds.add(value.sourcedId);
    }
    rows.push({ ...value, row: record.row });
    const modified = record.fields[modifiedColumn] ?? "";
    if (modified === "") continue;
    if (!ModifiedAt.safeParse(modified).success) {
      issues.push({ severity: "warning", file, row: record.row, column: "dateLastModified", message: "is not a date and time, so a delta cannot start from it" });
      continue;
    }
    highWater = Math.max(highWater ?? -Infinity, Date.parse(modified));
  }
  return { rows, ...(highWater === undefined ? {} : { highWater }) };
}
