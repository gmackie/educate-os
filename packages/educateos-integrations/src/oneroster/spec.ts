// Extracted from PlayTrek packages/edtech/src/oneroster/client.ts at commit 7258e4347: the OneRoster
// 1.2 entity vocabulary (statuses, org, session, class and role types). PlayTrek typed the REST JSON
// binding; this file types the CSV binding of the same entities, validates it with Zod, and adds the
// 1.2 `roles.csv` that the REST client never needed. The rows are also the model the REST binding is
// mapped into (`rest/rows.ts`), so list, boolean and `userIds` fields accept their JSON form too.
import { z } from "zod";

/** The OneRoster CSV files EducateOS reads, in the order a bulk import is mapped. */
export const ONEROSTER_FILES = [
  "orgs.csv",
  "academicSessions.csv",
  "courses.csv",
  "classes.csv",
  "users.csv",
  "roles.csv",
  "enrollments.csv",
] as const;

/** One of {@link ONEROSTER_FILES}. */
export type OneRosterFile = (typeof ONEROSTER_FILES)[number];

/**
 * The OneRoster 1.2 CSV header of each file EducateOS reads, in specification order. A file must
 * carry every one of these columns. It may add `metadata.*` extension columns, which are ignored;
 * any other column is an error.
 */
export const ONEROSTER_HEADERS: Readonly<Record<OneRosterFile, readonly string[]>> = {
  "orgs.csv": ["sourcedId", "status", "dateLastModified", "name", "type", "identifier", "parentSourcedId"],
  "academicSessions.csv": [
    "sourcedId", "status", "dateLastModified", "title", "type", "startDate", "endDate", "parentSourcedId",
    "schoolYear",
  ],
  "courses.csv": [
    "sourcedId", "status", "dateLastModified", "schoolYearSourcedId", "title", "courseCode", "grades",
    "orgSourcedId", "subjects", "subjectCodes",
  ],
  "classes.csv": [
    "sourcedId", "status", "dateLastModified", "title", "grades", "courseSourcedId", "classCode", "classType",
    "location", "schoolSourcedId", "termSourcedIds", "subjects", "subjectCodes", "periods",
  ],
  "users.csv": [
    "sourcedId", "status", "dateLastModified", "enabledUser", "username", "userIds", "givenName", "familyName",
    "middleName", "identifier", "email", "sms", "phone", "agentSourcedIds", "grades", "password",
    "userMasterIdentifier", "resourceSourcedIds", "preferredGivenName", "preferredMiddleName",
    "preferredFamilyName", "primaryOrgSourcedId", "pronouns",
  ],
  "roles.csv": [
    "sourcedId", "status", "dateLastModified", "userSourcedId", "roleType", "role", "beginDate", "endDate",
    "orgSourcedId", "userProfileSourcedId",
  ],
  "enrollments.csv": [
    "sourcedId", "status", "dateLastModified", "classSourcedId", "schoolSourcedId", "userSourcedId", "role",
    "primary", "beginDate", "endDate",
  ],
};

// CSV leaves an optional value blank. Each optional field reads a blank as absent before validating.
const blank = (value: unknown) => (value === "" ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const required = z.string().min(1, "is required");

/** A OneRoster `sourcedId`: the source system's identifier for a record. Opaque; never parsed. */
export const SourcedId = z.string().min(1, "is required").max(255);
/** A OneRoster `sourcedId`. */
export type SourcedId = z.infer<typeof SourcedId>;

/**
 * A record's status. A bulk file may leave it blank, which means active. `tobedeleted` never deletes
 * anything in EducateOS: see `import.ts` for what each kind of record does instead.
 */
const Status = z.preprocess(blank, z.enum(["active", "tobedeleted"]).default("active"));

/** A list: in CSV a comma-separated field, such as `"09,10"`; in JSON an array. */
const List = z.union([
  z.array(z.string()),
  z.string().transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "")),
]);

/** An ISO calendar date, which is how every OneRoster CSV date is written. */
const CsvDate = z.iso.date("expected a date as YYYY-MM-DD");

const CsvBoolean = z.union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")]);

const UserId = z.strictObject({ type: z.string().min(1), identifier: z.string() });

/**
 * A user's `userIds`. In CSV, a list of `{type:identifier}` pairs, such as `{LDAP:42},{SIS:9001}`,
 * where the type ends at the first colon and the identifier may contain colons of its own. In JSON,
 * an array of `{type, identifier}` objects.
 */
const UserIds = z.union([z.array(UserId), z.string().transform((value, ctx) => {
  const ids: { type: string; identifier: string }[] = [];
  const rest = value.replace(/\{([^{}:]+):([^{}]*)\}(?:,|$)/g, (_match, type: string, identifier: string) => {
    ids.push({ type, identifier });
    return "";
  });
  if (rest.trim() !== "") {
    ctx.addIssue({ code: "custom", message: "expected {type:identifier} pairs separated by commas" });
    return z.NEVER;
  }
  return ids;
})]);

/** The role vocabulary of OneRoster 1.2 `roles.csv`. */
export const OneRosterRole = z.enum([
  "aide",
  "counselor",
  "districtAdministrator",
  "guardian",
  "parent",
  "principal",
  "proctor",
  "relative",
  "siteAdministrator",
  "student",
  "systemAdministrator",
  "teacher",
]);
/** A OneRoster role. */
export type OneRosterRole = z.infer<typeof OneRosterRole>;

/**
 * The columns EducateOS reads from each file. Columns that are validated in the header but absent
 * here, such as `password`, `sms`, `phone` and `pronouns`, are never copied out of the CSV.
 */
export const ROW_SCHEMAS = {
  "orgs.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    name: required.max(200),
    type: z.enum(["department", "school", "district", "local", "state", "national"]),
    parentSourcedId: optional(SourcedId),
  }),
  "academicSessions.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    title: required.max(200),
    type: z.enum(["gradingPeriod", "semester", "schoolYear", "term"]),
    startDate: CsvDate,
    endDate: CsvDate,
    parentSourcedId: optional(SourcedId),
  }),
  "courses.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    title: required.max(200),
    grades: List,
    orgSourcedId: SourcedId,
    subjects: List,
    subjectCodes: List,
  }),
  "classes.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    title: required.max(100),
    grades: List,
    courseSourcedId: SourcedId,
    classType: z.enum(["homeroom", "scheduled"]),
    schoolSourcedId: SourcedId,
    termSourcedIds: List.pipe(z.array(SourcedId).min(1, "is required")),
  }),
  "users.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    enabledUser: CsvBoolean,
    // The specification requires `username`, but EducateOS reads it only when it is the configured
    // IdP subject. A blank subject quarantines the one user instead of failing the whole file.
    username: optional(z.string().max(255)),
    userIds: UserIds,
    givenName: required.max(100),
    familyName: required.max(100),
    identifier: optional(z.string().max(255)),
    email: optional(z.string()),
    grades: List,
  }),
  "roles.csv": z.strictObject({
    status: Status,
    userSourcedId: SourcedId,
    roleType: z.enum(["primary", "secondary"]),
    role: OneRosterRole,
    orgSourcedId: SourcedId,
  }),
  "enrollments.csv": z.strictObject({
    sourcedId: SourcedId,
    status: Status,
    classSourcedId: SourcedId,
    schoolSourcedId: SourcedId,
    userSourcedId: SourcedId,
    role: z.enum(["administrator", "proctor", "student", "teacher"]),
    primary: optional(CsvBoolean),
  }),
} as const satisfies Record<OneRosterFile, z.ZodType>;

/** A validated row of one OneRoster file, without its position. Parsing one again yields itself. */
export type OneRosterRecord<F extends OneRosterFile> = z.infer<(typeof ROW_SCHEMAS)[F]>;

/** A validated row of one OneRoster file, with the row it came from for error reporting. */
export type OneRosterRow<F extends OneRosterFile> = z.infer<(typeof ROW_SCHEMAS)[F]> & { row: number };
