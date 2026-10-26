// The OneRoster 1.2 REST query parameters: `filter`, `sort`/`orderBy` and `fields`. Followed: the
// 1EdTech OneRoster 1.2 Rostering REST/JSON Binding, sections 3.2 (sorting), 3.3 (filtering) and
// 3.4 (field selection). The grammar is `<field><op>'<value>'`, ops `= != > >= < <= ~` (`~` is
// "contains"), at most one ` AND ` or ` OR ` joining two predicates, values in single quotes and
// compared case-insensitively, dot notation for nested fields, and an unknown field refused with
// `invalid_filter_field`.

/** A query parameter the binding refuses, with the status-info code minor it names. */
export class QueryError extends Error {
  override readonly name = "QueryError";
  readonly codeMinor: "invalid_filter_field" | "invalid_selection_field" | "invalid_sort_field" | "invaliddata";

  constructor(codeMinor: QueryError["codeMinor"], message: string) {
    super(message);
    this.codeMinor = codeMinor;
  }
}

type Op = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~";
interface Predicate {
  readonly field: string;
  readonly op: Op;
  readonly value: string;
}

/** A parsed filter: predicates joined by one logical operator. */
export interface Filter {
  readonly predicates: readonly Predicate[];
  readonly logical: "AND" | "OR";
}

const PREDICATE = /^([A-Za-z_][\w.]*)\s*(!=|>=|<=|=|>|<|~)\s*'((?:[^']|'')*)'/;

/**
 * Parses a filter, checking its fields against `fields` (the collection's top-level fields). The
 * binding allows one logical operator; more predicates joined by the same operator are accepted,
 * mixed operators are refused.
 */
export function parseFilter(text: string, fields: readonly string[]): Filter {
  const predicates: Predicate[] = [];
  let logical: "AND" | "OR" | undefined;
  let rest = text.trim();
  for (;;) {
    const match = PREDICATE.exec(rest);
    if (match === null) throw new QueryError("invalid_filter_field", `the filter ${JSON.stringify(text)} is not <field><op>'<value>'`);
    const [whole, field, op, value] = match;
    if (!fields.includes(field!.split(".")[0]!)) throw new QueryError("invalid_filter_field", `${field} is not a field of this collection`);
    predicates.push({ field: field!, op: op as Op, value: value!.replaceAll("''", "'") });
    rest = rest.slice(whole.length);
    if (rest.trim() === "") break;
    const joined = /^ (AND|OR) /.exec(rest);
    if (joined === null) throw new QueryError("invalid_filter_field", `the filter ${JSON.stringify(text)} joins predicates with something other than " AND " or " OR "`);
    if (logical !== undefined && logical !== joined[1]) throw new QueryError("invalid_filter_field", "a filter uses one logical operator");
    logical = joined[1] as "AND" | "OR";
    rest = rest.slice(joined[0].length);
  }
  return { predicates, logical: logical ?? "AND" };
}

/** The values at a dot path, flattening arrays on the way (so `terms.sourcedId` is every term's). */
export function valuesAt(record: unknown, path: string): unknown[] {
  let values: unknown[] = [record];
  for (const key of path.split(".")) {
    values = values.flatMap((v) => (Array.isArray(v) ? v : [v])).flatMap((v) => (typeof v === "object" && v !== null && key in v ? [(v as Record<string, unknown>)[key]] : []));
  }
  return values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v !== undefined && v !== null);
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Compares two scalars: as times when both are ISO dates, as numbers when both are numeric, else as lowercased text. */
function compare(left: unknown, right: string): number {
  const l = String(left);
  if (ISO_TIME.test(l) && ISO_TIME.test(right)) return Math.sign(Date.parse(l) - Date.parse(right));
  if (typeof left === "number" || (/^-?\d+(\.\d+)?$/.test(l) && /^-?\d+(\.\d+)?$/.test(right))) return Math.sign(Number(l) - Number(right));
  const a = l.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function test(record: unknown, { field, op, value }: Predicate): boolean {
  const values = valuesAt(record, field);
  // Over an array, `=` has AND semantics across comma-separated values, `~` OR semantics.
  const wanted = value.split(",").map((v) => v.trim());
  const equal = () =>
    values.some((v) => compare(v, value) === 0) || (wanted.length > 1 && wanted.every((w) => values.some((v) => compare(v, w) === 0)));
  switch (op) {
    case "=":
      return equal();
    case "!=":
      return !equal();
    case "~":
      return values.some((v) => String(v).toLowerCase().includes(value.toLowerCase())) ||
        (wanted.length > 1 && wanted.some((w) => values.some((v) => String(v).toLowerCase().includes(w.toLowerCase()))));
    case ">":
      return values.some((v) => compare(v, value) > 0);
    case ">=":
      return values.some((v) => compare(v, value) >= 0);
    case "<":
      return values.some((v) => compare(v, value) < 0);
    case "<=":
      return values.some((v) => compare(v, value) <= 0);
  }
}

/** Whether a record passes a filter. */
export function passes(record: unknown, filter: Filter): boolean {
  return filter.logical === "AND" ? filter.predicates.every((p) => test(record, p)) : filter.predicates.some((p) => test(record, p));
}

/**
 * Sorts by `sort`, ascending unless `orderBy` is `desc`. An array field sorts by its first value;
 * records without the field sort last. Text compares as Unicode code points, case-insensitively,
 * which stands in for the Unicode Collation Algorithm the binding names.
 */
export function sortRecords<T>(records: readonly T[], sort: string, orderBy: "asc" | "desc", fields: readonly string[]): T[] {
  if (!fields.includes(sort.split(".")[0]!)) throw new QueryError("invalid_sort_field", `${sort} is not a field of this collection`);
  const direction = orderBy === "desc" ? -1 : 1;
  const key = (r: T) => valuesAt(r, sort)[0];
  return records.toSorted((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? 1 : -1;
    return direction * compare(ka, String(kb));
  });
}

/**
 * The `fields` selection: those fields and only those. A blank entry is invalid; a field the
 * collection does not have makes the server return every field, as the binding says.
 */
export function selectFields(values: readonly string[], fields: readonly string[]): ((record: Record<string, unknown>) => Record<string, unknown>) | undefined {
  if (values.length === 0) return undefined;
  const names = values.flatMap((v) => v.split(",")).map((n) => n.trim());
  if (names.some((n) => n === "")) throw new QueryError("invalid_selection_field", "a fields selection names a blank field");
  if (names.some((n) => !fields.includes(n))) return undefined;
  return (record) => Object.fromEntries(names.filter((n) => n in record).map((n) => [n, record[n]]));
}
