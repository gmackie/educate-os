// Clever as a roster source: a complete read of the Data API, and a delta from its events. Both
// yield the OneRoster row model, so `runRosterSync` imports a Clever roster exactly as it imports a
// OneRoster one. New for EducateOS.
import type { z } from "zod";
import type { OneRosterIssue } from "../oneroster/feed.ts";
import { ONEROSTER_FILES, ROW_SCHEMAS } from "../oneroster/spec.ts";
import type { OneRosterFile } from "../oneroster/spec.ts";
import { numberRows } from "../oneroster/sync.ts";
import type { RosterBatch, RosterMirror, RosterReadRequest, RosterSource } from "../oneroster/sync.ts";
import { RosterSyncError } from "../sync-run.ts";
import type { CleverDataClient } from "./client.ts";
import { cleverRows, sectionCourseSourcedId, type CleverRows, type CleverStatus } from "./mapping.ts";
import { CLEVER_COLLECTIONS, CLEVER_RECORD_SCHEMAS, CleverEvent } from "./schemas.ts";
import type { CleverCollection, CleverRecord } from "./schemas.ts";

/** The row-model file each collection's records are reported against. */
export const CLEVER_COLLECTION_FILES = {
  districts: "orgs.csv",
  schools: "orgs.csv",
  terms: "academicSessions.csv",
  courses: "courses.csv",
  sections: "classes.csv",
  users: "users.csv",
} as const satisfies Record<CleverCollection, OneRosterFile>;

// A source cursor is `clever-events:` and the ID of the last event applied, or nothing after the
// colon when the district had no events when the complete sync that set it started.
const CURSOR_PREFIX = "clever-events:";

/**
 * A roster source reading one Clever district. A complete read notes the newest event first and
 * then reads every collection; a delta reads the events since the last applied read, keeps the last
 * state of each record they name, and maps those records. Deleted records become `tobedeleted`, and
 * a section's update ends the enrollments of anyone it no longer lists.
 *
 * Events are snapshots of whole records, so reading one twice changes nothing. A delta always
 * starts from the cursor the last applied read left, which moves only when a sync applies.
 */
export function cleverRosterSource(client: CleverDataClient): RosterSource {
  return {
    kind: "clever",
    system: "clever",
    format: "clever",
    modes: ["complete", "delta"],
    read: (request) => (request.mode === "complete" ? readComplete(client) : readDelta(client, request)),
  };
}

/**
 * One record and whether it is current or deleted. `ended` marks a deletion whose last state did
 * not validate: only its ID is known, and it is ended from the baseline.
 */
interface Entry<C extends CleverCollection> {
  record: CleverRecord<C>;
  status: CleverStatus;
  ended?: true;
}
type Entries = { [C in CleverCollection]: Entry<C>[] };

async function readComplete(client: CleverDataClient): Promise<RosterBatch> {
  const issues: OneRosterIssue[] = [];
  let latest: string | undefined;
  let events = true;
  try {
    latest = await client.latestEventId();
  } catch (error) {
    // An app Clever has not given events can still sync whole rosters; it just has no deltas.
    if (!(error instanceof RosterSyncError && error.code === "auth-failed")) throw error;
    events = false;
    issues.push({ severity: "warning", message: "Clever refused the events API, so this roster can only be synced whole" });
  }
  const entries = emptyEntries();
  for (const collection of CLEVER_COLLECTIONS) {
    const { items } = await client.list(collection);
    items.forEach((item, index) => {
      const record = validate(collection, item, index, client.districtId, issues);
      if (record !== undefined) (entries[collection] as Entry<CleverCollection>[]).push({ record, status: "active" });
    });
  }
  if (!entries.districts.some((e) => e.record.id === client.districtId)) {
    throw new RosterSyncError("auth-failed", "the Clever token does not read the configured district");
  }
  return batch("complete", entries, undefined, issues, events ? `${CURSOR_PREFIX}${latest ?? ""}` : undefined);
}

async function readDelta(client: CleverDataClient, request: RosterReadRequest): Promise<RosterBatch> {
  const cursor = request.sourceCursor;
  if (cursor === undefined || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new RosterSyncError("no-baseline", "a Clever delta needs the event cursor of a complete Clever sync");
  }
  const after = cursor.slice(CURSOR_PREFIX.length) || undefined;
  const { items } = await client.events(after);
  const issues: OneRosterIssue[] = [];
  // The last state of each record the events name, in the order of its last event.
  const latest = new Map<string, { collection: CleverCollection; deleted: boolean; object: unknown; id: string }>();
  let lastId = after;
  for (const item of items) {
    const event = CleverEvent.safeParse(item);
    if (!event.success) {
      issues.push({ severity: "error", message: "an event is not a Clever event, so the delta cannot be applied" });
      continue;
    }
    lastId = event.data.id;
    const [collection, action] = event.data.type.split(".") as [string, string];
    if (!(CLEVER_COLLECTIONS as readonly string[]).includes(collection) || !["created", "updated", "deleted"].includes(action)) {
      issues.push({ severity: "warning", message: `event ${event.data.id} is a ${event.data.type} event, which EducateOS does not read` });
      continue;
    }
    const id = (event.data.data.object as { id?: unknown } | null)?.id;
    if (typeof id !== "string") {
      issues.push({ severity: "error", file: CLEVER_COLLECTION_FILES[collection as CleverCollection], message: `event ${event.data.id} names no record` });
      continue;
    }
    const key = `${collection}:${id}`;
    latest.delete(key);
    latest.set(key, { collection: collection as CleverCollection, deleted: action === "deleted", object: event.data.data.object, id });
  }

  const entries = emptyEntries();
  const baseline = request.baseline;
  let index = 0;
  for (const { collection, deleted, object, id } of latest.values()) {
    const status: CleverStatus = deleted ? "tobedeleted" : "active";
    const problems: OneRosterIssue[] = [];
    const record = validate(collection, object, index++, client.districtId, problems);
    if (record !== undefined) {
      (entries[collection] as Entry<CleverCollection>[]).push({ record, status });
    } else if (deleted && (collection === "users" || collection === "sections") && inBaseline(baseline, collection, id)) {
      // A deleted user's or section's last state matters only for what it removes, so one that no
      // longer validates is ended from the baseline instead (see `batch`).
      (entries[collection] as Entry<CleverCollection>[]).push({ record: { id } as never, status, ended: true });
    } else if (deleted) {
      // Nothing EducateOS holds is removed by it: a school, term or course is never deactivated,
      // and a user or section the roster never imported has nothing to end.
      issues.push({ severity: "warning", file: CLEVER_COLLECTION_FILES[collection], sourcedId: id, message: "was deleted in Clever; it cannot be read and nothing is removed" });
    } else {
      issues.push(...problems);
    }
  }
  return batch("delta", entries, baseline, issues, `${CURSOR_PREFIX}${lastId ?? ""}`);
}

function emptyEntries(): Entries {
  return { districts: [], schools: [], terms: [], courses: [], sections: [], users: [] };
}

function inBaseline(baseline: RosterMirror | undefined, collection: CleverCollection, id: string): boolean {
  const rows = baseline?.[CLEVER_COLLECTION_FILES[collection]] as { sourcedId: string }[] | undefined;
  return rows?.some((row) => row.sourcedId === id) ?? false;
}

/** Validates a record against its collection's schema and district, reporting why it is not valid. */
function validate<C extends CleverCollection>(
  collection: C,
  item: unknown,
  index: number,
  districtId: string,
  issues: OneRosterIssue[],
): CleverRecord<C> | undefined {
  const file = CLEVER_COLLECTION_FILES[collection];
  const rawId = (item as { id?: unknown } | null)?.id;
  const at = { file, row: index + 1, ...(typeof rawId === "string" && rawId.length <= 255 ? { sourcedId: rawId } : {}) };
  const result = (CLEVER_RECORD_SCHEMAS[collection] as unknown as z.ZodType<CleverRecord<C>>).safeParse(item);
  if (!result.success) {
    // A contact is never imported (EducateOS v1 has no roster guardians), so a malformed one is
    // only reported: it must not block the roster.
    // A null role is one the user does not hold.
    const roles = (item as { roles?: unknown } | null)?.roles;
    const held = typeof roles === "object" && roles !== null ? Object.entries(roles).flatMap(([role, body]) => (body == null ? [] : [role])) : [];
    const contactOnly = collection === "users" && held.join() === "contact";
    for (const issue of result.error.issues.slice(0, 10)) {
      issues.push({ severity: contactOnly ? "warning" : "error", ...at, column: issue.path.join("."), message: issue.message });
    }
    return undefined;
  }
  const record = result.data;
  const district = collection === "districts" ? record.id : (record as { district: string }).district;
  if (district !== districtId) {
    issues.push({ severity: "error", ...at, column: collection === "districts" ? "id" : "district", message: "belongs to another Clever district" });
    return undefined;
  }
  return record;
}

/**
 * Maps entries into a validated, numbered feed. For a delta, `baseline` supplies what the events
 * do not: the enrollments a section no longer lists, and the grades and subjects of a course whose
 * sections did not change.
 */
function batch(
  mode: "complete" | "delta",
  entries: Entries,
  baseline: RosterMirror | undefined,
  issues: OneRosterIssue[],
  sourceCursor: string | undefined,
): RosterBatch {
  const rows: CleverRows = Object.fromEntries(ONEROSTER_FILES.map((file) => [file, []])) as unknown as CleverRows;
  const schoolGrades = new Map(entries.schools.map((e) => [e.record.id, cleverRows.schoolGrades(e.record)]));
  const sectionsOf = new Map<string, CleverRecord<"sections">[]>();
  for (const { record, status } of entries.sections) {
    if (status === "active" && record.course !== undefined) append(sectionsOf, record.course, record);
  }
  const fallbackGrades = (sections: readonly CleverRecord<"sections">[]) => [...new Set(sections.flatMap((s) => schoolGrades.get(s.school) ?? []))];
  const baselineRows = <F extends OneRosterFile>(file: F) => (baseline?.[file] ?? []) as RosterMirror[F];

  for (const { record, status } of entries.districts) rows["orgs.csv"].push(cleverRows.district(record, status));
  for (const { record, status } of entries.schools) rows["orgs.csv"].push(cleverRows.school(record, status));
  for (const { record, status } of entries.terms) rows["academicSessions.csv"].push(cleverRows.term(record, status));
  // In a delta, a course's sections that the delta does not list still count, as the baseline has them.
  const changedSections = new Set(entries.sections.map((e) => e.record.id));
  const unchangedSectionGrades = (course: string) =>
    baselineRows("classes.csv")
      .filter((c) => c.courseSourcedId === course && c.status === "active" && !changedSections.has(c.sourcedId))
      .flatMap((c) => c.grades.map((grade) => ({ grade })));
  for (const { record, status } of entries.courses) {
    const sections = sectionsOf.get(record.id) ?? [];
    const previous = baselineRows("courses.csv").find((row) => row.sourcedId === record.id);
    const row = cleverRows.course(record, status, [...sections, ...unchangedSectionGrades(record.id)], fallbackGrades(sections));
    // A delta keeps what the course's sections said before where its own sections say nothing.
    if (previous !== undefined) {
      if (sections.length === 0 && row.grades?.length === 0) row.grades = previous.grades;
      row.subjects = [...new Set([...(row.subjects ?? []), ...previous.subjects])];
    }
    rows["courses.csv"].push(row);
  }
  for (const { record, status, ended } of entries.sections) {
    if (ended) {
      // A deletion known only from the baseline: end the section and everyone in it.
      endSection(record.id, rows, baselineRows);
      continue;
    }
    if (record.course === undefined) {
      const previous = baselineRows("courses.csv").find((row) => row.sourcedId === sectionCourseSourcedId(record.id));
      rows["courses.csv"].push(cleverRows.sectionCourse(record, status, fallbackGrades([record]).length > 0 ? fallbackGrades([record]) : (previous?.grades ?? [])));
    }
    rows["classes.csv"].push(cleverRows.section(record, status));
    const enrolled = cleverRows.enrollments(record, status);
    rows["enrollments.csv"].push(...enrolled);
    if (mode === "delta") {
      const listed = new Set(enrolled.map((e) => e.sourcedId));
      for (const previous of baselineRows("enrollments.csv")) {
        if (previous.classSourcedId === record.id && !listed.has(previous.sourcedId)) {
          rows["enrollments.csv"].push({ ...previous, status: "tobedeleted" });
        }
      }
    }
  }
  for (const { record, status, ended } of entries.users) {
    if (ended) {
      const previous = baselineRows("users.csv").find((row) => row.sourcedId === record.id)!;
      rows["users.csv"].push({ ...previous, status: "tobedeleted" });
      rows["roles.csv"].push(...baselineRows("roles.csv").filter((r) => r.userSourcedId === record.id).map((r) => ({ ...r, status: "tobedeleted" as const })));
      continue;
    }
    const { user, roles } = cleverRows.user(record, status);
    rows["users.csv"].push(user);
    rows["roles.csv"].push(...roles);
  }

  const valid = Object.fromEntries(ONEROSTER_FILES.map((file) => [file, [] as Record<string, unknown>[]])) as Record<OneRosterFile, Record<string, unknown>[]>;
  for (const file of ONEROSTER_FILES) {
    (rows[file] as Record<string, unknown>[]).forEach((row, index) => {
      const result = (ROW_SCHEMAS[file] as z.ZodType<Record<string, unknown>>).safeParse(row);
      if (result.success) {
        valid[file].push(result.data);
        return;
      }
      const sourcedId = typeof row["sourcedId"] === "string" ? row["sourcedId"] : typeof row["userSourcedId"] === "string" ? row["userSourcedId"] : undefined;
      for (const issue of result.error.issues) {
        issues.push({
          severity: "error",
          file,
          row: index + 1,
          ...(sourcedId === undefined ? {} : { sourcedId }),
          column: String(issue.path[0]),
          message: issue.message,
        });
      }
    });
  }
  return { mode, feed: numberRows(valid as RosterMirror), issues, sourceCursor };
}

/** Marks a baseline section, and every baseline enrollment in it, `tobedeleted`. */
function endSection(id: string, rows: CleverRows, baselineRows: <F extends OneRosterFile>(file: F) => RosterMirror[F]): void {
  const section = baselineRows("classes.csv").find((row) => row.sourcedId === id);
  if (section !== undefined) rows["classes.csv"].push({ ...section, status: "tobedeleted" });
  for (const enrollment of baselineRows("enrollments.csv")) {
    if (enrollment.classSourcedId === id) rows["enrollments.csv"].push({ ...enrollment, status: "tobedeleted" });
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
