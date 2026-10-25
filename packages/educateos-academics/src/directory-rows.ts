// How a directory is laid out as rows, shared by the two SQL stores: `D1AcademicStore` and
// `DurableObjectAcademicStore`. Both keep the tables `migrations/0001_academic_directory.sql`
// creates, so a district's directory can move from a Durable Object to D1 as rows, unchanged.
import { DistrictDirectorySnapshot } from "@educateos/contracts";

/** The record lists of a directory and the table each is stored in. */
export const RECORD_TABLES = {
  schools: "academic_schools",
  terms: "academic_terms",
  courses: "academic_courses",
  offerings: "academic_offerings",
  principals: "academic_principals",
  enrollments: "academic_enrollments",
  roleAssignments: "academic_role_assignments",
} as const satisfies Record<Exclude<keyof DistrictDirectorySnapshot, "district">, string>;

/** One of a directory's record lists. */
export type RecordList = keyof typeof RECORD_TABLES;
/** Every record list, in table order. */
export const RECORD_LISTS = Object.keys(RECORD_TABLES) as RecordList[];

/**
 * JSON with object keys sorted, so a record serializes the same however it was built and the
 * store can tell a changed row from an unchanged one by comparing strings.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** A record's key in its table: its ID, or for a role assignment (which has none) its JSON. */
function keyOf(record: object, json: string): string {
  return "id" in record && typeof record.id === "string" ? record.id : json;
}

/** One stored record: where it sits in its list, and its canonical JSON. */
export interface Row {
  position: number;
  json: string;
}

/** Each list's rows by key, as the store holds them. */
export type Rows = Record<RecordList, Map<string, Row>>;

/** The rows `snapshot` is stored as. */
export function rowsOf(snapshot: DistrictDirectorySnapshot): Rows {
  const rows = {} as Rows;
  for (const list of RECORD_LISTS) {
    rows[list] = new Map(
      (snapshot[list] as object[]).map((record, position) => {
        const json = canonicalJson(record);
        return [keyOf(record, json), { position, json }];
      }),
    );
  }
  return rows;
}

/** One row write a commit makes. */
export type RowChange =
  | { kind: "delete"; list: RecordList; key: string }
  | { kind: "insert" | "update"; list: RecordList; key: string; row: Row };

/**
 * The row writes that turn `current` into `next`: removed records, then inserted or changed ones
 * (content or position). Unchanged rows are not written.
 */
export function rowChanges(current: DistrictDirectorySnapshot, next: DistrictDirectorySnapshot): RowChange[] {
  const before = rowsOf(current);
  const after = rowsOf(next);
  const changes: RowChange[] = [];
  for (const list of RECORD_LISTS) {
    for (const key of before[list].keys()) {
      if (!after[list].has(key)) changes.push({ kind: "delete", list, key });
    }
    for (const [key, row] of after[list]) {
      const was = before[list].get(key);
      if (was === undefined) changes.push({ kind: "insert", list, key, row });
      else if (was.json !== row.json || was.position !== row.position) changes.push({ kind: "update", list, key, row });
    }
  }
  return changes;
}

/**
 * Parses stored rows back into a directory with the contract schema, so a row edited outside the
 * store fails the load rather than reaching a decision. `lists` holds each list's JSON in position
 * order. The error names field paths only: the rows hold personal data, and an unreadable row is
 * not trusted to be safe to log.
 */
export function parseStoredDirectory(districtJson: string, lists: Record<RecordList, readonly string[]>): DistrictDirectorySnapshot {
  const raw: Record<string, unknown> = { district: JSON.parse(districtJson) };
  for (const list of RECORD_LISTS) raw[list] = lists[list].map((json) => JSON.parse(json));
  const parsed = DistrictDirectorySnapshot.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`the stored academic directory is unreadable at ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}
