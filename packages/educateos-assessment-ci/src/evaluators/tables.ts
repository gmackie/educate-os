// Built-in evaluators for spreadsheets and datasets submitted as CSV.
import { z } from "zod";
import { CsvSyntaxError, findColumn, numericCell, parseTable, sameUnit, type CsvColumn, type CsvTable } from "../csv.ts";
import { defineEvaluator, type CriterionEvidence, type EvaluationArtifact, type EvaluationInput, type EvaluationKit, type Excerpt } from "../sdk.ts";
import { excerptOf } from "./writing.ts";

/** The tabular work these evaluators read. */
export const TABULAR_WORK = { artifactTypes: ["spreadsheet", "dataset"], mediaTypes: ["text/csv"] } as const;

const ColumnName = z.string().trim().min(1).max(200);
const Unit = z.string().trim().min(1).max(50);

interface Table {
  artifact: EvaluationArtifact;
  table: CsvTable;
}

/**
 * The submitted tables, or the evidence that one could not be read. A table that is not CSV is
 * evidence against the criterion, not a failed run: it is a fact about the submitted work.
 */
function readTables(input: EvaluationInput, kit: EvaluationKit): { tables: Table[]; unreadable: CriterionEvidence[] } {
  const tables: Table[] = [];
  const unreadable: CriterionEvidence[] = [];
  for (const artifact of input.artifacts) {
    try {
      const table = parseTable(artifact.text, kit);
      if (table !== undefined) tables.push({ artifact, table });
    } catch (error) {
      if (!(error instanceof CsvSyntaxError)) throw error;
      unreadable.push({ criterionId: input.criterionId, observation: "The table could not be read", passed: false, excerpts: [], explanation: error.message });
    }
  }
  return { tables, unreadable };
}

function locate(tables: readonly Table[], name: string): { at: Table; column: CsvColumn } | undefined {
  for (const at of tables) {
    const column = findColumn(at.table, name);
    if (column !== undefined) return { at, column };
  }
  return undefined;
}

function headerExcerpt(at: Table): Excerpt {
  return excerptOf(at.artifact, at.table.header.range);
}

function missingColumn(input: EvaluationInput, name: string): CriterionEvidence {
  return { criterionId: input.criterionId, observation: `No ${name} column`, passed: false, excerpts: [], explanation: `No submitted table has a column named "${name}".` };
}

function unitProblem(column: CsvColumn, unit: string | undefined): string | undefined {
  if (unit === undefined) return undefined;
  if (column.unit === undefined) return `its header "${column.header}" gives no unit; expected (${unit})`;
  if (!sameUnit(column.unit, unit)) return `its unit is ${column.unit}; expected ${unit}`;
  return undefined;
}

/**
 * `spreadsheet.assertions`: each listed column is present, its header names the expected unit in
 * brackets (`Mass (g)`), and every value in it is a number within the given range.
 */
export const spreadsheetAssertions = defineEvaluator({
  id: "spreadsheet.assertions",
  release: "1.0.0",
  accepts: TABULAR_WORK,
  answerKeyed: false,
  config: z.strictObject({
    columns: z.array(z.strictObject({
      name: ColumnName,
      unit: Unit.optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }).refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, "min is at most max")).min(1).max(50),
  }),
  evaluate(input, config, kit) {
    const { tables, unreadable } = readTables(input, kit);
    if (tables.length === 0) return unreadable;
    return config.columns.map((expected) => {
      const found = locate(tables, expected.name);
      if (found === undefined) return missingColumn(input, expected.name);
      const problems: string[] = [];
      const unit = unitProblem(found.column, expected.unit);
      if (unit !== undefined) problems.push(unit);
      const outside: Excerpt[] = [];
      if (expected.min !== undefined || expected.max !== undefined) {
        let bad = 0;
        for (const row of found.at.table.rows) {
          kit.step();
          const value = numericCell(row.fields[found.column.index]);
          if (value !== undefined && (expected.min === undefined || value >= expected.min) && (expected.max === undefined || value <= expected.max)) continue;
          bad += 1;
          if (outside.length < 5) outside.push(excerptOf(found.at.artifact, row.range));
        }
        if (bad > 0) {
          const range = expected.min === undefined ? `at most ${expected.max}` : expected.max === undefined ? `at least ${expected.min}` : `${expected.min} to ${expected.max}`;
          problems.push(`${bad} value${bad === 1 ? " is" : "s are"} missing, not numbers, or outside ${range}`);
        }
      }
      return {
        criterionId: input.criterionId,
        observation: problems.length === 0 ? `${found.column.header}: as expected` : `${found.column.header}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`,
        passed: problems.length === 0,
        excerpts: [headerExcerpt(found.at), ...outside],
        explanation: problems.length === 0
          ? `The ${expected.name} column is present${expected.unit === undefined ? "" : ` in ${expected.unit}`}${expected.min === undefined && expected.max === undefined ? "" : ", with every value in range"}.`
          : `In the ${expected.name} column, ${problems.join("; ")}.`,
      };
    });
  },
});

/** How a column's values are combined into one value. */
export const Aggregate = z.enum(["mean", "median", "sum", "min", "max"]);
/** An aggregate. */
export type Aggregate = z.infer<typeof Aggregate>;

function aggregate(kind: Aggregate, values: readonly number[]): number {
  switch (kind) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "mean":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return values.reduce((a, b) => Math.min(a, b));
    case "max":
      return values.reduce((a, b) => Math.max(a, b));
    case "median": {
      const sorted = values.toSorted((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    }
  }
}

/** A number as a teacher reads it: at most six significant digits. */
function shown(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * `spreadsheet.computed-value`: a value computed from a column (its mean, median, sum, minimum or
 * maximum) matches the teacher's fixture within a tolerance. The fixture is an answer key, so this
 * check is always teacher-only.
 */
export const spreadsheetComputedValue = defineEvaluator({
  id: "spreadsheet.computed-value",
  release: "1.0.0",
  accepts: TABULAR_WORK,
  answerKeyed: true,
  config: z.strictObject({
    column: ColumnName,
    unit: Unit.optional(),
    aggregate: Aggregate,
    expected: z.number(),
    tolerance: z.number().nonnegative(),
  }),
  evaluate(input, config, kit) {
    const { tables, unreadable } = readTables(input, kit);
    if (tables.length === 0) return unreadable;
    const found = locate(tables, config.column);
    if (found === undefined) return [missingColumn(input, config.column)];
    const unit = unitProblem(found.column, config.unit);
    const values: number[] = [];
    for (const row of found.at.table.rows) {
      kit.step();
      const value = numericCell(row.fields[found.column.index]);
      if (value !== undefined) values.push(value);
    }
    if (values.length === 0) {
      return [{ criterionId: input.criterionId, observation: `No numbers in ${found.column.header}`, passed: false, excerpts: [headerExcerpt(found.at)], explanation: `The ${config.column} column has no numeric values to compute a ${config.aggregate} from.` }];
    }
    kit.step(values.length);
    const value = aggregate(config.aggregate, values);
    const difference = Math.abs(value - config.expected);
    const within = difference <= config.tolerance;
    return [{
      criterionId: input.criterionId,
      observation: `${config.aggregate} of ${found.column.header} is ${shown(value)}`,
      passed: within && unit === undefined,
      excerpts: [headerExcerpt(found.at)],
      explanation: `The ${config.aggregate} of ${values.length} values is ${shown(value)}; the fixture expects ${shown(config.expected)} ± ${shown(config.tolerance)}, so it is ${within ? "within" : "outside"} tolerance (off by ${shown(difference)})${unit === undefined ? "" : `, and ${unit}`}.`,
    }];
  },
});

/**
 * `dataset.structure`: every row has as many fields as the header, the row count is within bounds,
 * a key column is filled and unique, the listed columns hold only numbers, and the listed columns
 * have no empty cells.
 */
export const datasetStructure = defineEvaluator({
  id: "dataset.structure",
  release: "1.0.0",
  accepts: TABULAR_WORK,
  answerKeyed: false,
  config: z.strictObject({
    minRows: z.int().nonnegative().optional(),
    maxRows: z.int().positive().optional(),
    keyColumn: ColumnName.optional(),
    numericColumns: z.array(ColumnName).max(50).default([]),
    requiredValues: z.array(ColumnName).max(50).default([]),
  }).refine((c) => c.minRows === undefined || c.maxRows === undefined || c.minRows <= c.maxRows, "minRows is at most maxRows"),
  evaluate(input, config, kit) {
    const { tables, unreadable } = readTables(input, kit);
    if (tables.length === 0) return unreadable;
    const [first] = tables;
    const at = first!;
    const { header, rows } = at.table;
    const evidence: CriterionEvidence[] = [];

    const ragged = rows.filter((row) => row.fields.length !== header.fields.length);
    evidence.push({
      criterionId: input.criterionId,
      observation: ragged.length === 0 ? `${header.fields.length} columns in every row` : `${ragged.length} row${ragged.length === 1 ? "" : "s"} with the wrong number of fields`,
      passed: ragged.length === 0,
      excerpts: ragged.length === 0 ? [headerExcerpt(at)] : ragged.slice(0, 5).map((r) => excerptOf(at.artifact, r.range)),
      explanation: ragged.length === 0 ? `Every row has the header's ${header.fields.length} fields.` : `The header has ${header.fields.length} fields, but some rows do not.`,
    });

    if (config.minRows !== undefined || config.maxRows !== undefined) {
      const min = config.minRows ?? 0;
      const max = config.maxRows ?? Number.POSITIVE_INFINITY;
      evidence.push({
        criterionId: input.criterionId,
        observation: `${rows.length} data row${rows.length === 1 ? "" : "s"}`,
        passed: rows.length >= min && rows.length <= max,
        excerpts: [],
        explanation: `The table has ${rows.length} rows after its header; ${config.maxRows === undefined ? `at least ${min}` : config.minRows === undefined ? `at most ${max}` : `${min} to ${max}`} expected.`,
      });
    }

    const cells = (name: string): { column: CsvColumn; cells: { value: string; row: (typeof rows)[number] }[] } | undefined => {
      const column = findColumn(at.table, name);
      if (column === undefined) return undefined;
      return { column, cells: rows.map((row) => ({ value: (row.fields[column.index] ?? "").trim(), row })) };
    };
    const columnEvidence = (name: string, problem: string, check: (value: string, seen: Set<string>) => boolean) => {
      const found = cells(name);
      if (found === undefined) return missingColumn(input, name);
      const seen = new Set<string>();
      const bad = found.cells.filter(({ value }) => {
        kit.step();
        const ok = check(value, seen);
        seen.add(value);
        return !ok;
      });
      return {
        criterionId: input.criterionId,
        observation: bad.length === 0 ? `${found.column.header}: no ${problem}` : `${found.column.header}: ${bad.length} ${problem}`,
        passed: bad.length === 0,
        excerpts: bad.length === 0 ? [headerExcerpt(at)] : bad.slice(0, 5).map(({ row }) => excerptOf(at.artifact, row.range)),
        explanation: bad.length === 0 ? `The ${name} column has no ${problem}.` : `The ${name} column has ${bad.length} ${problem}.`,
      };
    };
    if (config.keyColumn !== undefined) {
      evidence.push(columnEvidence(config.keyColumn, "empty or repeated keys", (value, seen) => value !== "" && !seen.has(value)));
    }
    for (const name of config.numericColumns) evidence.push(columnEvidence(name, "values that are not numbers", (value) => numericCell(value) !== undefined));
    for (const name of config.requiredValues) evidence.push(columnEvidence(name, "empty cells", (value) => value !== ""));
    return evidence;
  },
});
