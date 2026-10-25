// Maps OneRoster 1.2 REST records into the row model the CSV path reads, and serves them as a
// roster source. The field mapping follows PlayTrek packages/edtech/src/oneroster/mapping.ts at
// commit 7258e4347; the source and delta reads are new.
import { z } from "zod";
import { RosterSyncError } from "../../sync-run.ts";
import type { OneRosterHighWater, OneRosterIssue } from "../feed.ts";
import { ONEROSTER_FILES, ROW_SCHEMAS } from "../spec.ts";
import type { OneRosterFile } from "../spec.ts";
import { numberRows } from "../sync.ts";
import type { RosterBatch, RosterMirror, RosterReadRequest, RosterSource } from "../sync.ts";
import { COLLECTION_FILES } from "./client.ts";
import type { OneRosterRestClient } from "./client.ts";
import { DateTime, ROSTER_COLLECTIONS } from "./schemas.ts";
import type { RosterCollection, RosterRecord } from "./schemas.ts";

/** Each collection's records as rows, unvalidated. The row schemas validate them next. */
const TO_ROWS: { [C in RosterCollection]: (record: RosterRecord<C>) => { file: OneRosterFile; row: unknown }[] } = {
  orgs: (r) => [{
    file: "orgs.csv",
    row: { sourcedId: r.sourcedId, status: r.status, name: r.name, type: r.type, parentSourcedId: r.parent?.sourcedId },
  }],
  academicSessions: (r) => [{
    file: "academicSessions.csv",
    row: {
      sourcedId: r.sourcedId,
      status: r.status,
      title: r.title,
      type: r.type,
      startDate: r.startDate,
      endDate: r.endDate,
      parentSourcedId: r.parent?.sourcedId,
    },
  }],
  courses: (r) => [{
    file: "courses.csv",
    row: {
      sourcedId: r.sourcedId,
      status: r.status,
      title: r.title,
      grades: r.grades ?? [],
      orgSourcedId: r.org.sourcedId,
      subjects: r.subjects ?? [],
      subjectCodes: r.subjectCodes ?? [],
    },
  }],
  classes: (r) => [{
    file: "classes.csv",
    row: {
      sourcedId: r.sourcedId,
      status: r.status,
      title: r.title,
      grades: r.grades ?? [],
      courseSourcedId: r.course.sourcedId,
      classType: r.classType,
      schoolSourcedId: r.school.sourcedId,
      termSourcedIds: r.terms.map((t) => t.sourcedId),
    },
  }],
  // A REST user carries its roles; the row model keeps them in roles.csv, as the CSV binding does.
  // Only the fields the row model reads are copied: never `password`, `userProfiles`, `sms` or `phone`.
  users: (r) => [
    {
      file: "users.csv",
      row: {
        sourcedId: r.sourcedId,
        status: r.status,
        enabledUser: r.enabledUser,
        username: r.username,
        userIds: r.userIds ?? [],
        givenName: r.givenName,
        familyName: r.familyName,
        identifier: r.identifier,
        email: r.email,
        grades: r.grades ?? [],
      },
    },
    ...r.roles.map((role) => ({
      file: "roles.csv" as const,
      row: {
        status: r.status,
        userSourcedId: r.sourcedId,
        roleType: role.roleType,
        role: role.role,
        orgSourcedId: role.org.sourcedId,
      },
    })),
  ],
  enrollments: (r) => [{
    file: "enrollments.csv",
    row: {
      sourcedId: r.sourcedId,
      status: r.status,
      classSourcedId: r.class.sourcedId,
      schoolSourcedId: r.school.sourcedId,
      userSourcedId: r.user.sourcedId,
      role: r.role,
      primary: r.primary,
    },
  }],
};

/**
 * A roster source reading a OneRoster 1.2 REST server. A complete read fetches every record of
 * each collection; a delta fetches, from each collection, those with `dateLastModified` at or after
 * that collection's own cursor, and the whole collection when it has none.
 *
 * The delta filter is inclusive, and each cursor already starts an overlap window before the
 * newest record last read (see `nextCursors`), so a record modified while the roster was being
 * read is read again rather than missed. Reading a record twice changes nothing, since applying a
 * delta is idempotent.
 */
export function restRosterSource(client: OneRosterRestClient): RosterSource {
  return {
    kind: "oneroster-rest",
    format: "rest",
    modes: ["complete", "delta"],
    read: (request) => readRest(client, request),
  };
}

/** The `dateLastModified` filter for a collection's delta, or none to read it whole. */
function deltaFilter(collection: RosterCollection, request: RosterReadRequest): string | undefined {
  if (request.mode !== "delta") return undefined;
  const cursor = request.since?.[COLLECTION_FILES[collection]];
  if (cursor === undefined) return undefined;
  const since = DateTime.safeParse(cursor);
  if (!since.success) throw new RosterSyncError("no-baseline", "a delta needs the cursor of an earlier sync");
  // The cursor is validated as an ISO timestamp, so it cannot close the quoted filter value.
  return `dateLastModified>='${new Date(since.data).toISOString()}'`;
}

async function readRest(client: OneRosterRestClient, request: RosterReadRequest): Promise<RosterBatch> {
  const rows = Object.fromEntries(ONEROSTER_FILES.map((file) => [file, [] as Record<string, unknown>[]])) as Record<
    OneRosterFile,
    Record<string, unknown>[]
  >;
  const issues: OneRosterIssue[] = [];
  const highWater: OneRosterHighWater = {};
  for (const collection of ROSTER_COLLECTIONS) {
    const filter = deltaFilter(collection, request);
    const read = await client.list(collection, filter === undefined ? {} : { filter });
    let newest: number | undefined;
    issues.push(...read.issues);
    // Sorted here as well as by the server, so the feed is the same whatever order it served.
    const records = (read.records as RosterRecord<RosterCollection>[]).toSorted((a, b) => compare(a.sourcedId, b.sourcedId));
    for (const [index, record] of records.entries()) {
      const modified = Date.parse(record.dateLastModified);
      if (newest === undefined || modified > newest) newest = modified;
      const toRows = TO_ROWS[collection] as (record: RosterRecord<RosterCollection>) => { file: OneRosterFile; row: unknown }[];
      for (const { file, row } of toRows(record)) {
        const target = rows[file];
        const result = (ROW_SCHEMAS[file] as z.ZodType<Record<string, unknown>>).safeParse(row);
        if (result.success) {
          target.push(result.data);
          continue;
        }
        for (const issue of result.error.issues) {
          issues.push({
            severity: "error",
            file: COLLECTION_FILES[collection],
            row: index + 1,
            sourcedId: record.sourcedId,
            column: String(issue.path[0]),
            message: issue.message,
          });
        }
      }
    }
    if (newest !== undefined) highWater[COLLECTION_FILES[collection]] = new Date(newest).toISOString();
  }
  return { mode: request.mode, feed: numberRows(rows as RosterMirror), issues, highWater };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
