// Maps a OneRoster feed onto a district directory. The order of work (orgs, sessions, courses,
// classes, users, enrollments) and the user, class and enrollment mapping start from PlayTrek
// packages/edtech/src/oneroster/sync.ts and mapping.ts at commit 7258e4347. PlayTrek upserted rows
// as it went; EducateOS builds the whole next snapshot first, diffs it against the current one, and
// applies nothing unless every record passes. Identity linking, quarantine and deactivation are new.
import {
  AcademicTerm,
  CatalogCourse,
  CourseOffering,
  DistrictDirectorySnapshot,
  Enrollment,
  Principal,
  RoleAssignment,
  School,
  EducateOsError,
  IdpSubjectField as ContractIdpSubjectField,
  ProviderName,
  RosterIdentityMapping,
  checkDirectoryIntegrity,
  externalIdentityKey,
  type SourceLink,
} from "@educateos/contracts";
import type {
  CourseId,
  DirectoryIssue,
  DistrictId,
  EnrollmentId,
  OfferingId,
  PrincipalId,
  PrincipalKind,
  SchoolId,
  TermId,
  TermState,
} from "@educateos/contracts";
import { z } from "zod";
import { readOneRosterCsv } from "./feed.ts";
import type { OneRosterCsvFiles, OneRosterCsvLimits, OneRosterFeed, OneRosterIssue } from "./feed.ts";
import { gradeBandFor, subjectFor } from "./mapping.ts";
import { OneRosterSourceMap, derivedId } from "./source-map.ts";
import type { ImportedKind } from "./source-map.ts";
import { ONEROSTER_FILES } from "./spec.ts";
import type { OneRosterFile, OneRosterRole, OneRosterRow } from "./spec.ts";

/**
 * Which users.csv field holds the subject the district's IdP asserts for each user (the contracts
 * `IdpSubjectField`).
 */
export const IdpSubjectField = ContractIdpSubjectField;
/** An IdP subject field. */
export type IdpSubjectField = ContractIdpSubjectField;

/**
 * How a district's roster relates to its IdP (the contracts `RosterIdentityMapping`), as a
 * configuration revision stores it under `rostering.identityMapping`.
 */
export const OneRosterImportConfig = RosterIdentityMapping;
/** A OneRoster import configuration. */
export type OneRosterImportConfig = RosterIdentityMapping;

/** A district directory and the record of which of its entries came from the roster. */
export interface RosterState {
  /** The directory. */
  snapshot: DistrictDirectorySnapshot;
  /** The OneRoster source of each roster-managed record in it. */
  sources: OneRosterSourceMap;
}

/** Everything one import needs. */
export interface OneRosterImportInput {
  /** The directory as it stands. For a first import, a snapshot holding only the district. */
  current: RosterState;
  /** The bulk export. */
  files: OneRosterCsvFiles;
  /** How the roster relates to the IdP. */
  config: OneRosterImportConfig;
  /** The time of the import. Term states are computed from it in the district's time zone. */
  now: Date;
  /** Size limits, when not the defaults. */
  limits?: OneRosterCsvLimits;
}

/**
 * How a feed was delivered, which decides how issues name where a record is: a CSV export's
 * `users.csv`, or a REST server's `users` collection.
 */
export type OneRosterFormat = "csv" | "rest" | "clever";

/**
 * An import of a feed already read into rows, by any source. The feed is the whole roster: a
 * roster record it does not list is treated as gone, exactly as for a bulk export.
 */
export interface OneRosterFeedImportInput extends Omit<OneRosterImportInput, "files" | "limits"> {
  /** The rows. */
  feed: OneRosterFeed;
  /** The issues found reading the feed. An `error` among them blocks apply. */
  issues: readonly OneRosterIssue[];
  /** How the feed was delivered, for the wording of issues. A bulk CSV export when absent. */
  format?: OneRosterFormat;
  /** The system principals' source links name (the contracts `ProviderName`). `oneroster` when absent. */
  system?: string;
}

/** Where a row-model file's records come from in a feed of each format, as issues name it. */
const PLACES: Readonly<Record<OneRosterFormat, Readonly<Record<OneRosterFile, string>>>> = {
  csv: Object.fromEntries(ONEROSTER_FILES.map((file) => [file, file])) as Record<OneRosterFile, string>,
  rest: {
    "orgs.csv": "the orgs collection",
    "academicSessions.csv": "the academicSessions collection",
    "courses.csv": "the courses collection",
    "classes.csv": "the classes collection",
    "users.csv": "the users collection",
    "roles.csv": "the users' roles",
    "enrollments.csv": "the enrollments collection",
  },
  clever: {
    "orgs.csv": "Clever's districts and schools",
    "academicSessions.csv": "Clever's terms",
    "courses.csv": "Clever's courses",
    "classes.csv": "Clever's sections",
    "users.csv": "Clever's users",
    "roles.csv": "the Clever users' roles",
    "enrollments.csv": "Clever's section rosters",
  },
};

/**
 * How an import changes one kind of record. Nothing is ever removed: a record the feed no longer
 * lists is either `deactivated` (principals and enrollments) or `retained` unchanged.
 */
export interface EntityChanges<Id extends string> {
  /** Records the import creates. */
  added: Id[];
  /** Records whose fields change, including a principal the roster lists again. */
  updated: Id[];
  /** Records that become inactive because the feed dropped them or marked them `tobedeleted`. */
  deactivated: Id[];
  /** Roster records the feed no longer lists that stay exactly as they are. */
  retained: Id[];
}

/** Every change an import would make. */
export interface OneRosterChanges {
  /** Schools. */
  schools: EntityChanges<SchoolId>;
  /** Terms. */
  terms: EntityChanges<TermId>;
  /** Catalog courses. */
  courses: EntityChanges<CourseId>;
  /** Course offerings. */
  offerings: EntityChanges<OfferingId>;
  /** Principals. */
  principals: EntityChanges<PrincipalId>;
  /** Enrollments. */
  enrollments: EntityChanges<EnrollmentId>;
  /** Role assignments the import grants and removes. Only `roster` assignments ever change. */
  roleAssignments: { added: RoleAssignment[]; removed: RoleAssignment[] };
}

/** Why a user was quarantined. */
export const QuarantineReason = z.enum([
  /** The configured subject field is blank. */
  "missing-subject",
  /** Another user in the same feed has the same subject. */
  "duplicate-subject",
  /** The roster user already has a principal, linked to a different subject. */
  "subject-changed",
  /** The subject is linked to a principal that belongs to a different roster user. */
  "subject-in-use",
  /** The user's roles now make them a student where they were staff, or the reverse. */
  "kind-changed",
  /** The user holds both student and staff roles. */
  "conflicting-roles",
  /** roles.csv gives the user no role. */
  "no-role",
]);
/** A quarantine reason. */
export type QuarantineReason = z.infer<typeof QuarantineReason>;

/**
 * A roster user the import leaves out until an administrator resolves them. Their principal, if
 * they have one, and its enrollments and roster roles are held exactly as they are: never remapped,
 * never deactivated.
 */
export interface QuarantinedUser {
  /** The user's `sourcedId`. */
  sourcedId: string;
  /** The users.csv row. */
  row: number;
  /** The user's existing principal, when the roster already manages one. */
  principalId?: PrincipalId;
  /** Why. */
  reason: QuarantineReason;
  /** The detail an administrator needs to resolve it. */
  message: string;
  /** How many of the user's enrollment rows were held back. */
  heldEnrollments: number;
}

/** A roster user linked to a principal the roster did not manage, because they share an identity. */
export interface LinkedIdentity {
  /** The user's `sourcedId`. */
  sourcedId: string;
  /** The principal it was linked to, which keeps its ID. */
  principalId: PrincipalId;
}

/** What an import would do, for an administrator to review before applying it. */
export interface OneRosterPreview {
  /** Whether {@link applyOneRosterImport} would apply it: no error issues and no integrity issues. */
  canApply: boolean;
  /** Problems in the feed. Any `error` blocks apply. */
  issues: OneRosterIssue[];
  /** Integrity problems in the snapshot the import would produce. Any blocks apply. */
  integrity: DirectoryIssue[];
  /** Users left out. They do not block apply. */
  quarantined: QuarantinedUser[];
  /** Users linked to existing principals by identity. */
  linked: LinkedIdentity[];
  /** The changes. */
  changes: OneRosterChanges;
}

/** The outcome of {@link applyOneRosterImport}. */
export type OneRosterApplyResult =
  | { applied: true; next: RosterState; preview: OneRosterPreview }
  | { applied: false; preview: OneRosterPreview };

/** Shows what importing a feed would change, without changing anything. */
export async function previewOneRosterImport(input: OneRosterImportInput): Promise<OneRosterPreview> {
  return (await planImport(readCsvInput(input))).preview;
}

/**
 * Imports a feed: returns the next directory and source map, but only when the feed has no errors
 * and the result passes `checkDirectoryIntegrity`. Otherwise nothing is returned to apply, and the
 * preview says why. A malformed row therefore blocks the whole import rather than being skipped,
 * because skipping a user's row would read as that user leaving the roster.
 *
 * Applying the result and then importing the same feed again changes nothing.
 */
export async function applyOneRosterImport(input: OneRosterImportInput): Promise<OneRosterApplyResult> {
  return applyOneRosterFeed(readCsvInput(input));
}

/** {@link previewOneRosterImport} for a feed already read, such as one fetched over REST. */
export async function previewOneRosterFeed(input: OneRosterFeedImportInput): Promise<OneRosterPreview> {
  return (await planImport(input)).preview;
}

/** {@link applyOneRosterImport} for a feed already read, such as one fetched over REST. */
export async function applyOneRosterFeed(input: OneRosterFeedImportInput): Promise<OneRosterApplyResult> {
  const { preview, next } = await planImport(input);
  return preview.canApply ? { applied: true, next, preview } : { applied: false, preview };
}

function readCsvInput({ files, limits, ...rest }: OneRosterImportInput): OneRosterFeedImportInput {
  return { ...rest, ...readOneRosterCsv(files, limits) };
}

/** Whether an import changes anything at all. */
export function hasChanges(changes: OneRosterChanges): boolean {
  return Object.values(changes).some((change) =>
    Object.entries(change).some(([key, ids]) => key !== "retained" && (ids as unknown[]).length > 0)
  );
}

const STAFF_ROLES = new Set<OneRosterRole>([
  "aide",
  "counselor",
  "districtAdministrator",
  "principal",
  "proctor",
  "siteAdministrator",
  "systemAdministrator",
  "teacher",
]);
const FAMILY_ROLES = new Set<OneRosterRole>(["guardian", "parent", "relative"]);
const SCHOOL_ADMIN_ROLES = new Set<OneRosterRole>(["principal", "siteAdministrator"]);
const DISTRICT_ADMIN_ROLES = new Set<OneRosterRole>(["districtAdministrator", "systemAdministrator"]);
const EMAIL = z.email();
const IMPORTED_KINDS: readonly ImportedKind[] = ["schools", "terms", "courses", "offerings", "principals", "enrollments"];

async function planImport(input: OneRosterFeedImportInput): Promise<{ preview: OneRosterPreview; next: RosterState }> {
  const ctx = await createContext(input);
  const catalog = mapCatalog(ctx);
  const people = linkUsers(ctx);
  const enrollments = mapEnrollments(ctx, catalog, people);
  const sources = nextSourceMap(ctx, catalog, people, enrollments);
  const roleAssignments = projectRoles(ctx, catalog, people, enrollments, sources);
  return assemble(ctx, catalog, people, enrollments, sources, roleAssignments);
}

/** What every stage of an import reads, and where it reports issues. */
interface ImportContext {
  config: OneRosterImportConfig;
  current: DistrictDirectorySnapshot;
  sources: OneRosterSourceMap;
  feed: OneRosterFeed;
  districtId: DistrictId;
  /** The import date in the district's time zone, as YYYY-MM-DD. */
  today: string;
  /** The time of the import: the `lastSeenAt` of every principal source link it confirms. */
  seenAt: string;
  issues: OneRosterIssue[];
  /**
   * The ID of a record in the feed: the one the source map already gives its sourcedId, else a
   * derived one.
   */
  idFor(kind: ImportedKind, sourcedId: string): string;
  /** The ID of a record an earlier import mapped, if the directory still holds it. */
  retainedId(kind: ImportedKind, sourcedId: string): string | undefined;
  error(file: OneRosterFile, row: number, column: string, message: string): void;
  warn(file: OneRosterFile, row: number, column: string, message: string): void;
  /** Where a file's records come from, in the feed's own terms (`users.csv`, the users collection). */
  place(file: OneRosterFile): string;
  /** The system principals' source links name. */
  system: string;
}

async function createContext(input: OneRosterFeedImportInput): Promise<ImportContext> {
  const config = parseInput(OneRosterImportConfig, input.config, "import config");
  const current = parseInput(DistrictDirectorySnapshot, input.current.snapshot, "current snapshot");
  // Checked before anything is mapped: every principal the import makes would name this issuer.
  if (!current.district.trustedIssuers.includes(config.issuer)) {
    throw new EducateOsError("validation-failed", `the roster's issuer ${config.issuer} is not one of the district's trusted issuers`);
  }
  const sources = parseInput(OneRosterSourceMap, input.current.sources, "source map");
  const districtId = current.district.id;
  const today = dateInZone(input.now, current.district.timeZone);
  const feed = input.feed;
  const issues = [...input.issues];

  const known = {} as Record<ImportedKind, Map<string, string>>;
  for (const kind of IMPORTED_KINDS) {
    known[kind] = new Map();
    for (const [id, source] of Object.entries(sources[kind])) {
      const sourcedId = typeof source === "string" ? source : source.sourcedId;
      if (known[kind].has(sourcedId)) {
        throw new EducateOsError("validation-failed", `source map gives ${kind} sourcedId ${sourcedId} two IDs`);
      }
      known[kind].set(sourcedId, id);
    }
  }
  const feedIds: Record<ImportedKind, string[]> = {
    schools: feed["orgs.csv"].filter((o) => o.type === "school").map((o) => o.sourcedId),
    terms: feed["academicSessions.csv"].map((s) => s.sourcedId),
    courses: feed["courses.csv"].map((c) => c.sourcedId),
    offerings: feed["classes.csv"].map((c) => c.sourcedId),
    principals: feed["users.csv"].map((u) => u.sourcedId),
    enrollments: feed["enrollments.csv"].map((e) => e.sourcedId),
  };
  const derived = {} as Record<ImportedKind, Map<string, string>>;
  await Promise.all(IMPORTED_KINDS.map(async (kind) => {
    derived[kind] = new Map(
      await Promise.all(feedIds[kind].map(async (s) => [s, await derivedId(districtId, kind, s)] as const)),
    );
  }));
  const rowSources = new Map<string, string>();
  for (const file of Object.keys(feed) as OneRosterFile[]) {
    for (const row of feed[file]) if ("sourcedId" in row) rowSources.set(`${file}:${row.row}`, row.sourcedId);
  }
  const located = (file: OneRosterFile, row: number) => {
    const sourcedId = rowSources.get(`${file}:${row}`);
    return { file, row, ...(sourcedId === undefined ? {} : { sourcedId }) };
  };
  const currentIds: Record<ImportedKind, Set<string>> = {
    schools: new Set(current.schools.map((r) => r.id)),
    terms: new Set(current.terms.map((r) => r.id)),
    courses: new Set(current.courses.map((r) => r.id)),
    offerings: new Set(current.offerings.map((r) => r.id)),
    principals: new Set(current.principals.map((r) => r.id)),
    enrollments: new Set(current.enrollments.map((r) => r.id)),
  };

  return {
    config,
    current,
    sources,
    feed,
    districtId,
    today,
    seenAt: input.now.toISOString(),
    issues,
    idFor: (kind, sourcedId) => known[kind].get(sourcedId) ?? derived[kind].get(sourcedId)!,
    retainedId: (kind, sourcedId) => {
      const id = known[kind].get(sourcedId);
      return id !== undefined && currentIds[kind].has(id) ? id : undefined;
    },
    error: (file, row, column, message) => issues.push({ severity: "error", ...located(file, row), column, message }),
    warn: (file, row, column, message) => issues.push({ severity: "warning", ...located(file, row), column, message }),
    place: (file) => PLACES[input.format ?? "csv"][file],
    system: ProviderName.parse(input.system ?? "oneroster"),
  };
}

/** The rows of a file that are not marked `tobedeleted`. */
function live<F extends OneRosterFile>(feed: OneRosterFeed, file: F): OneRosterRow<F>[] {
  return (feed[file] as OneRosterRow<F>[]).filter((row) => row.status === "active");
}

/** The schools, terms, courses and offerings the feed maps, keyed by sourcedId. */
interface Catalog {
  schools: Map<string, School>;
  terms: Map<string, AcademicTerm>;
  courses: Map<string, CatalogCourse>;
  offerings: Map<string, CourseOffering>;
  /** The ID of a school the feed or an earlier import maps. */
  schoolId(sourcedId: string): string | undefined;
  /** The offering of a class the feed or an earlier import maps. */
  offeringId(sourcedId: string): string | undefined;
  /** Classes whose rows already raised an error, so that enrollments naming them do not repeat it. */
  failedClasses: Set<string>;
  /** Classes marked `tobedeleted`. Their enrollments go inactive. */
  deletedClasses: Set<string>;
}

/**
 * Maps orgs, sessions, courses and classes. A row marked `tobedeleted` is neither created nor
 * updated, and an earlier copy of it stays as it was: EducateOS has nowhere to record a school, term,
 * course or offering as deleted, and deleting one would orphan the work recorded against it.
 */
function mapCatalog(ctx: ImportContext): Catalog {
  const { feed, current, districtId } = ctx;
  const classes = live(feed, "classes.csv");
  const courseRows = new Map(feed["courses.csv"].map((c) => [c.sourcedId, c]));
  // The grade codes of each school's and each course's classes, for records that list none.
  const schoolGrades = new Map<string, string[]>();
  const courseClassGrades = new Map<string, string[]>();
  for (const c of classes) {
    append(schoolGrades, c.schoolSourcedId, ...c.grades, ...(courseRows.get(c.courseSourcedId)?.grades ?? []));
    append(courseClassGrades, c.courseSourcedId, ...c.grades);
  }

  const schools = new Map<string, School>();
  for (const org of live(feed, "orgs.csv")) {
    if (org.type !== "school") continue;
    const id = ctx.idFor("schools", org.sourcedId);
    const band = gradeBandFor(schoolGrades.get(org.sourcedId) ?? []);
    const previous = current.schools.find((s) => s.id === id);
    if (band === undefined && previous === undefined) {
      ctx.warn("orgs.csv", org.row, "sourcedId", "no class at this school lists a K-12 grade, so it is recorded as K-12");
    }
    schools.set(org.sourcedId, School.parse({
      id,
      districtId,
      name: org.name,
      gradeBands: band !== undefined ? [band] : (previous?.gradeBands ?? ["K-12"]),
    }));
  }

  // Only terms and semesters become EducateOS terms. A class may name a grading period instead, in
  // which case its term is the nearest term or semester above it.
  const sessions = new Map(feed["academicSessions.csv"].map((s) => [s.sourcedId, s]));
  const termSessionOf = (sourcedId: string): string | undefined => {
    const seen = new Set<string>();
    for (let s = sessions.get(sourcedId); s !== undefined && !seen.has(s.sourcedId); s = sessions.get(s.parentSourcedId ?? "")) {
      seen.add(s.sourcedId);
      if (s.type === "term" || s.type === "semester") return s.sourcedId;
      if (s.type !== "gradingPeriod") return undefined;
    }
    return undefined;
  };
  const terms = new Map<string, AcademicTerm>();
  for (const session of live(feed, "academicSessions.csv")) {
    if (session.type !== "term" && session.type !== "semester") continue;
    if (session.startDate > session.endDate) {
      ctx.error("academicSessions.csv", session.row, "endDate", "is before startDate");
      continue;
    }
    const id = ctx.idFor("terms", session.sourcedId);
    const previous = current.terms.find((t) => t.id === id);
    terms.set(session.sourcedId, AcademicTerm.parse({
      id,
      districtId,
      name: session.title,
      startsOn: session.startDate,
      endsOn: session.endDate,
      state: termState(session.startDate, session.endDate, ctx.today, previous?.state),
    }));
  }

  const courses = new Map<string, CatalogCourse>();
  const failedCourses = new Set<string>();
  for (const course of live(feed, "courses.csv")) {
    const band = gradeBandFor(course.grades) ?? gradeBandFor(courseClassGrades.get(course.sourcedId) ?? []);
    if (band === undefined) {
      ctx.error("courses.csv", course.row, "grades", "lists no K-12 grade, and neither do its classes");
      failedCourses.add(course.sourcedId);
      continue;
    }
    courses.set(course.sourcedId, CatalogCourse.parse({
      id: ctx.idFor("courses", course.sourcedId),
      districtId,
      title: course.title,
      subject: subjectFor(course.subjects, course.subjectCodes),
      gradeBand: band,
    }));
  }

  const resolve = (kind: ImportedKind, mapped: Map<string, { id: string }>) => (sourcedId: string) =>
    mapped.get(sourcedId)?.id ?? ctx.retainedId(kind, sourcedId);
  const schoolId = resolve("schools", schools);
  const termId = resolve("terms", terms);
  const courseId = resolve("courses", courses);

  const offerings = new Map<string, CourseOffering>();
  const failedClasses = new Set<string>();
  for (const cls of classes) {
    const school = schoolId(cls.schoolSourcedId);
    const course = courseId(cls.courseSourcedId);
    // A class may also list its school year; only its terms and semesters decide its term.
    const termSessions = new Set(cls.termSourcedIds.map(termSessionOf).filter((s) => s !== undefined));
    const term = termSessions.size === 1 ? termId([...termSessions][0]!) : undefined;
    if (school === undefined) {
      ctx.error("classes.csv", cls.row, "schoolSourcedId", `names ${cls.schoolSourcedId}, which ${ctx.place("orgs.csv")} does not list as an active school`);
    }
    if (course === undefined && !failedCourses.has(cls.courseSourcedId)) {
      ctx.error("classes.csv", cls.row, "courseSourcedId", `names ${cls.courseSourcedId}, which ${ctx.place("courses.csv")} does not list as active`);
    }
    if (termSessions.size > 1) {
      ctx.error("classes.csv", cls.row, "termSourcedIds", "spans more than one term; EducateOS offerings belong to one");
    } else if (term === undefined) {
      ctx.error("classes.csv", cls.row, "termSourcedIds", `names no active term or semester in ${ctx.place("academicSessions.csv")}`);
    }
    if (school === undefined || course === undefined || term === undefined) {
      failedClasses.add(cls.sourcedId);
      continue;
    }
    offerings.set(cls.sourcedId, CourseOffering.parse({
      id: ctx.idFor("offerings", cls.sourcedId),
      districtId,
      schoolId: school,
      termId: term,
      courseId: course,
      sectionName: cls.title,
    }));
  }

  return {
    schools,
    terms,
    courses,
    offerings,
    schoolId,
    offeringId: resolve("offerings", offerings),
    failedClasses,
    deletedClasses: new Set(feed["classes.csv"].filter((c) => c.status === "tobedeleted").map((c) => c.sourcedId)),
  };
}

/** What became of one users.csv row. */
type UserOutcome =
  | { kind: "import"; id: string; principalKind: PrincipalKind }
  /** Listed but `tobedeleted`, disabled or no longer importable. `id` is set when the roster already manages them. */
  | { kind: "absent"; id?: string }
  | { kind: "quarantined"; entry: QuarantinedUser }
  /** A guardian, parent or relative the roster never managed: EducateOS v1 has no such principals. */
  | { kind: "skipped" };

/** The roster's people: what became of each user, and the principals imported. */
interface People {
  /** By users.csv sourcedId. */
  outcomes: Map<string, UserOutcome>;
  /** The principals imported, by ID. */
  principals: Map<string, Principal>;
  linked: LinkedIdentity[];
  /** Existing principals of quarantined users, whose records the import must not touch. */
  held: Set<string>;
}

/**
 * Decides each user's principal. A user's principal is the one the source map already gives their
 * sourcedId, else an existing principal holding the same `(issuer, subject)` identity, else a new
 * one. Whenever those disagree, or the subject is missing or shared, the user is quarantined: the
 * import never moves an identity from one principal to another.
 */
function linkUsers(ctx: ImportContext): People {
  const { feed, current, config, districtId } = ctx;
  const userRows = new Set(feed["users.csv"].map((u) => u.sourcedId));
  const rolesByUser = new Map<string, OneRosterRole[]>();
  for (const role of live(feed, "roles.csv")) {
    if (userRows.has(role.userSourcedId)) append(rolesByUser, role.userSourcedId, role.role);
    else ctx.error("roles.csv", role.row, "userSourcedId", `names ${role.userSourcedId}, which is not in ${ctx.place("users.csv")}`);
  }

  const principalsById = new Map<string, Principal>(current.principals.map((p) => [p.id, p]));
  const identityOwner = new Map<string, string>();
  for (const principal of current.principals) {
    for (const identity of principal.externalIdentities) identityOwner.set(externalIdentityKey(identity), principal.id);
  }
  const managedBy = new Map(Object.entries(ctx.sources.principals).map(([id, s]) => [id, s.sourcedId]));

  const outcomes = new Map<string, UserOutcome>();
  const quarantine = (user: OneRosterRow<"users.csv">, reason: QuarantineReason, message: string, principalId?: string) =>
    outcomes.set(user.sourcedId, {
      kind: "quarantined",
      entry: {
        sourcedId: user.sourcedId,
        row: user.row,
        ...(principalId === undefined ? {} : { principalId: principalId as PrincipalId }),
        reason,
        message,
        heldEnrollments: 0,
      },
    });

  const candidates: { user: OneRosterRow<"users.csv">; existing: string | undefined; kind: PrincipalKind; subject: string }[] = [];
  for (const user of feed["users.csv"]) {
    const existing = ctx.retainedId("principals", user.sourcedId);
    if (user.status === "tobedeleted" || !user.enabledUser) {
      outcomes.set(user.sourcedId, { kind: "absent", ...(existing === undefined ? {} : { id: existing }) });
      continue;
    }
    const roles = rolesByUser.get(user.sourcedId) ?? [];
    const isStudent = roles.includes("student");
    const isStaff = roles.some((r) => STAFF_ROLES.has(r));
    if (isStudent && isStaff) {
      quarantine(user, "conflicting-roles", "holds both student and staff roles", existing);
    } else if (!isStudent && !isStaff && roles.some((r) => FAMILY_ROLES.has(r))) {
      outcomes.set(user.sourcedId, existing === undefined ? { kind: "skipped" } : { kind: "absent", id: existing });
      ctx.warn("users.csv", user.row, "sourcedId", "is a guardian, parent or relative; EducateOS does not import them");
    } else if (!isStudent && !isStaff) {
      quarantine(user, "no-role", `has no role in ${ctx.place("roles.csv")}`, existing);
    } else {
      const subject = subjectOf(user, config.subject);
      if (subject === undefined) quarantine(user, "missing-subject", `has no ${describeField(config.subject)}`, existing);
      else candidates.push({ user, existing, kind: isStudent ? "student" : "staff", subject });
    }
  }

  const subjectCounts = new Map<string, number>();
  for (const { subject } of candidates) subjectCounts.set(subject, (subjectCounts.get(subject) ?? 0) + 1);

  const linked: LinkedIdentity[] = [];
  const principals = new Map<string, Principal>();
  for (const { user, existing, kind, subject } of candidates) {
    if (subjectCounts.get(subject)! > 1) {
      quarantine(user, "duplicate-subject", `shares the subject ${subject} with another user in ${ctx.place("users.csv")}`, existing);
      continue;
    }
    let id: string;
    if (existing !== undefined) {
      const subjects = principalsById.get(existing)!.externalIdentities
        .filter((i) => i.issuer === config.issuer)
        .map((i) => i.subject);
      if (!subjects.includes(subject)) {
        quarantine(user, "subject-changed", `was linked to ${subjects.join(", ") || "no subject"} and is now ${subject}; EducateOS will not remap a principal`, existing);
        continue;
      }
      id = existing;
    } else {
      const owner = identityOwner.get(externalIdentityKey({ districtId, issuer: config.issuer, subject }));
      const ownerSource = owner === undefined ? undefined : managedBy.get(owner);
      if (ownerSource !== undefined && ownerSource !== user.sourcedId) {
        quarantine(user, "subject-in-use", `has the subject ${subject}, which belongs to roster user ${ownerSource}`);
        continue;
      }
      id = owner ?? ctx.idFor("principals", user.sourcedId);
    }

    const previous = principalsById.get(id);
    if (previous !== undefined && previous.kind !== kind) {
      quarantine(user, "kind-changed", `is now ${kind} but their principal is ${previous.kind}`, existing);
      continue;
    }
    if (previous !== undefined && existing === undefined) linked.push({ sourcedId: user.sourcedId, principalId: id as PrincipalId });

    const email = user.email === undefined ? undefined : EMAIL.safeParse(user.email);
    if (email?.success === false) ctx.warn("users.csv", user.row, "email", "is not a valid address and is left out");
    // The roster owns a roster principal's email: one it no longer lists is removed.
    const fields: Partial<Principal> = { ...previous };
    delete fields.email;
    principals.set(id, Principal.parse({
      externalIdentities: [{ districtId, issuer: config.issuer, subject }],
      ...fields,
      id,
      districtId,
      kind,
      // The roster owns a roster principal's status: one it lists is active again.
      status: "active",
      displayName: `${user.givenName} ${user.familyName}`,
      ...(email?.success ? { email: email.data } : {}),
    }));
    outcomes.set(user.sourcedId, { kind: "import", id, principalKind: kind });
  }

  const held = new Set<string>();
  for (const outcome of outcomes.values()) {
    if (outcome.kind === "quarantined" && outcome.entry.principalId !== undefined) held.add(outcome.entry.principalId);
  }
  return { outcomes, principals, linked, held };
}

/** Enrollments the import writes, by ID, with the sourcedId of each one the feed lists. */
interface Enrollments {
  records: Map<string, Enrollment>;
  sources: Map<string, string>;
}

/**
 * Maps enrollment rows, then makes every roster enrollment the feed no longer lists inactive.
 * Enrollments of quarantined users are held: neither written nor deactivated.
 */
function mapEnrollments(ctx: ImportContext, catalog: Catalog, people: People): Enrollments {
  const currentEnrollments = new Map<string, Enrollment>(ctx.current.enrollments.map((e) => [e.id, e]));
  const currentKinds = new Map(ctx.current.principals.map((p) => [p.id as string, p.kind]));
  const records = new Map<string, Enrollment>();
  const sources = new Map<string, string>();
  for (const row of ctx.feed["enrollments.csv"]) {
    const outcome = people.outcomes.get(row.userSourcedId);
    if (outcome === undefined) {
      ctx.error("enrollments.csv", row.row, "userSourcedId", `names ${row.userSourcedId}, which is not in ${ctx.place("users.csv")}`);
      continue;
    }
    if (outcome.kind === "quarantined") {
      outcome.entry.heldEnrollments++;
      continue;
    }
    if (row.role === "administrator" || row.role === "proctor") {
      ctx.warn("enrollments.csv", row.row, "role", `is ${row.role}; EducateOS enrolls only students and teachers`);
      continue;
    }
    // A user the import does not manage (a guardian, or one deleted before ever being imported).
    if (outcome.kind === "skipped" || outcome.id === undefined) continue;
    const principalId = outcome.id;
    const offeringId = catalog.offeringId(row.classSourcedId);
    if (offeringId === undefined) {
      if (!catalog.failedClasses.has(row.classSourcedId) && !catalog.deletedClasses.has(row.classSourcedId)) {
        ctx.error("enrollments.csv", row.row, "classSourcedId", `names ${row.classSourcedId}, which is not in ${ctx.place("classes.csv")}`);
      }
      continue;
    }
    const kind = outcome.kind === "import" ? outcome.principalKind : currentKinds.get(principalId);
    if ((row.role === "student") !== (kind === "student")) {
      ctx.error("enrollments.csv", row.row, "role", `enrolls a ${kind} user as ${row.role}`);
      continue;
    }
    const id = ctx.idFor("enrollments", row.sourcedId);
    const previous = currentEnrollments.get(id);
    if (previous !== undefined && (previous.principalId !== principalId || previous.offeringId !== offeringId)) {
      ctx.error("enrollments.csv", row.row, "sourcedId", "now names a different user or class; EducateOS will not move an enrollment");
      continue;
    }
    const inactive = row.status === "tobedeleted" || outcome.kind === "absent" || catalog.deletedClasses.has(row.classSourcedId);
    records.set(id, Enrollment.parse({
      id,
      districtId: ctx.districtId,
      offeringId,
      principalId,
      role: row.role === "student" ? "student" : row.primary === false ? "co-teacher" : "teacher",
      status: inactive ? "inactive" : "active",
    }));
    sources.set(id, row.sourcedId);
  }
  for (const id of Object.keys(ctx.sources.enrollments)) {
    const previous = currentEnrollments.get(id);
    if (previous !== undefined && !records.has(id) && !people.held.has(previous.principalId)) {
      records.set(id, { ...previous, status: "inactive" });
    }
  }
  return { records, sources };
}

/**
 * The source map after the import. Entries are only ever added; a principal the feed lists has its
 * link's `lastSeenAt` moved to this import.
 */
function nextSourceMap(ctx: ImportContext, catalog: Catalog, people: People, enrollments: Enrollments): OneRosterSourceMap {
  const next = structuredClone(ctx.sources);
  record(next.schools, catalog.schools);
  record(next.terms, catalog.terms);
  record(next.courses, catalog.courses);
  record(next.offerings, catalog.offerings);
  const enrollmentSources: Record<string, string> = next.enrollments;
  for (const [id, sourcedId] of enrollments.sources) enrollmentSources[id] = sourcedId;

  const principals: Record<string, SourceLink> = next.principals;
  for (const [sourcedId, outcome] of people.outcomes) {
    if (outcome.kind === "import") principals[outcome.id] = { system: ctx.system, sourcedId, lastSeenAt: ctx.seenAt };
  }
  return next;
}

/**
 * The role assignments after the import. Every roster principal's `roster` assignments are
 * replaced with those its active enrollments and school roles give it; local grants, principals the
 * roster does not manage and held principals keep theirs. District administration is never granted
 * from a roster, since that would let whoever controls the export make anyone a district admin.
 */
function projectRoles(
  ctx: ImportContext,
  catalog: Catalog,
  people: People,
  enrollments: Enrollments,
  sources: OneRosterSourceMap,
): RoleAssignment[] {
  const { current, districtId } = ctx;
  const offerings = new Map<string, CourseOffering>([...current.offerings, ...catalog.offerings.values()].map((o) => [o.id, o]));
  const roleAssignments = current.roleAssignments.filter((a) =>
    a.source !== "roster" || !Object.hasOwn(sources.principals, a.principalId) || people.held.has(a.principalId)
  );
  const assigned = new Set(roleAssignments.map(canonical));
  const grant = (assignment: RoleAssignment) => {
    const key = canonical(assignment);
    if (assigned.has(key)) return;
    assigned.add(key);
    roleAssignments.push(RoleAssignment.parse(assignment));
  };

  for (const enrollment of enrollments.records.values()) {
    if (enrollment.status !== "active" || enrollment.role === "student" || !people.principals.has(enrollment.principalId)) continue;
    const offering = offerings.get(enrollment.offeringId)!;
    grant({
      principalId: enrollment.principalId,
      role: enrollment.role,
      scope: { level: "offering", districtId, schoolId: offering.schoolId, offeringId: offering.id },
      source: "roster",
    });
  }
  for (const role of live(ctx.feed, "roles.csv")) {
    const outcome = people.outcomes.get(role.userSourcedId);
    if (outcome?.kind !== "import") continue;
    if (DISTRICT_ADMIN_ROLES.has(role.role)) {
      ctx.warn("roles.csv", role.row, "role", `is ${role.role}; district administration is granted in EducateOS, never from the roster`);
    } else if (SCHOOL_ADMIN_ROLES.has(role.role)) {
      const schoolId = catalog.schoolId(role.orgSourcedId);
      if (schoolId === undefined) {
        ctx.warn("roles.csv", role.row, "orgSourcedId", `names ${role.orgSourcedId}, which is not a school; no school role is granted`);
        continue;
      }
      grant({
        principalId: outcome.id as PrincipalId,
        role: "school-admin",
        scope: { level: "school", districtId, schoolId: schoolId as SchoolId },
        source: "roster",
      });
    }
  }
  return roleAssignments;
}

/** Lays the import over the current directory, checks the result and describes the difference. */
function assemble(
  ctx: ImportContext,
  catalog: Catalog,
  people: People,
  enrollments: Enrollments,
  sources: OneRosterSourceMap,
  roleAssignments: RoleAssignment[],
): { preview: OneRosterPreview; next: RosterState } {
  const { current } = ctx;
  const schools = merge(current.schools, [...catalog.schools.values()], ctx.sources.schools);
  const terms = merge(current.terms, [...catalog.terms.values()], ctx.sources.terms);
  const courses = merge(current.courses, [...catalog.courses.values()], ctx.sources.courses);
  const offerings = merge(current.offerings, [...catalog.offerings.values()], ctx.sources.offerings);
  const enrollmentMerge = merge(current.enrollments, [...enrollments.records.values()], ctx.sources.enrollments, (before, after) =>
    before.status === "active" && after.status === "inactive"
  );
  // A roster principal the feed no longer lists becomes inactive, unless it is held. It is never
  // removed, and one that is already inactive or graduated stays as it is.
  const dropped = current.principals.flatMap((p) =>
    Object.hasOwn(ctx.sources.principals, p.id) && !people.principals.has(p.id) && !people.held.has(p.id) && p.status === "active"
      ? [{ ...p, status: "inactive" as const }]
      : [],
  );
  const principals = merge(current.principals, [...people.principals.values(), ...dropped], ctx.sources.principals, (before, after) =>
    before.status === "active" && after.status !== "active"
  );
  const statusOf = new Map(principals.records.map((p) => [p.id, p.status]));
  // A held principal keeps its record and status, and is reported as nothing.
  const principalChanges: EntityChanges<PrincipalId> = {
    ...principals.changes,
    retained: principals.changes.retained.filter((id) => statusOf.get(id) !== "active"),
  };

  const snapshot: DistrictDirectorySnapshot = {
    district: current.district,
    schools: schools.records,
    terms: terms.records,
    courses: courses.records,
    offerings: offerings.records,
    principals: principals.records,
    enrollments: enrollmentMerge.records,
    roleAssignments,
  };
  const before = new Set(current.roleAssignments.map(canonical));
  const after = new Set(roleAssignments.map(canonical));
  const integrity = checkDirectoryIntegrity(snapshot);

  return {
    preview: {
      canApply: !ctx.issues.some((i) => i.severity === "error") && integrity.length === 0,
      issues: ctx.issues,
      integrity,
      quarantined: [...people.outcomes.values()].flatMap((o) => (o.kind === "quarantined" ? [o.entry] : [])),
      linked: people.linked,
      changes: {
        schools: schools.changes,
        terms: terms.changes,
        courses: courses.changes,
        offerings: offerings.changes,
        principals: principalChanges,
        enrollments: enrollmentMerge.changes,
        roleAssignments: {
          added: roleAssignments.filter((a) => !before.has(canonical(a))),
          removed: current.roleAssignments.filter((a) => !after.has(canonical(a))),
        },
      },
    },
    next: { snapshot, sources },
  };
}

/**
 * Lays incoming records over the current ones by ID: existing records keep their position, new ones
 * follow in feed order, and no record is dropped. `deactivates` says whether a change counts as a
 * deactivation rather than an update.
 */
function merge<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  managed: Readonly<Record<string, unknown>>,
  deactivates: (before: T, after: T) => boolean = () => false,
): { records: T[]; changes: EntityChanges<T["id"]> } {
  const byId = new Map(incoming.map((r) => [r.id, r]));
  const changes: EntityChanges<T["id"]> = { added: [], updated: [], deactivated: [], retained: [] };
  const records = current.map((before) => {
    const after = byId.get(before.id);
    byId.delete(before.id);
    if (after === undefined) {
      if (Object.hasOwn(managed, before.id)) changes.retained.push(before.id);
      return before;
    }
    if (canonical(before) !== canonical(after)) {
      (deactivates(before, after) ? changes.deactivated : changes.updated).push(before.id);
    }
    return after;
  });
  for (const added of byId.values()) {
    changes.added.push(added.id);
    records.push(added);
  }
  return { records, changes };
}

/**
 * A term's state on `today`. The roster knows only dates, so a term the district has moved into
 * `grading` stays there after its end date rather than jumping to `completed`.
 */
function termState(startsOn: string, endsOn: string, today: string, previous: TermState | undefined): TermState {
  if (today < startsOn) return "planned";
  if (today <= endsOn) return "active";
  return previous === "grading" ? "grading" : "completed";
}

/** The calendar date of an instant in a time zone, as YYYY-MM-DD. */
function dateInZone(now: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  } catch {
    throw new EducateOsError("validation-failed", `district time zone ${timeZone} is not a known IANA time zone`);
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A user's IdP subject from the configured field, or undefined when it is blank. */
function subjectOf(user: OneRosterRow<"users.csv">, field: IdpSubjectField): string | undefined {
  const value = field.field === "userIds"
    ? user.userIds.find((id) => id.type === field.type)?.identifier
    : user[field.field];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function describeField(field: IdpSubjectField): string {
  return field.field === "userIds" ? `userIds entry of type ${field.type}` : field.field;
}

/** A JSON encoding with sorted keys, so two records compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** Records the sourcedId of each mapped record in a source map entry. */
function record(target: Record<string, string>, mapped: Map<string, { id: string }>): void {
  for (const [sourcedId, { id }] of mapped) target[id] = sourcedId;
}

/** Appends values to a list in a map, creating it when absent. */
function append<T>(map: Map<string, T[]>, key: string, ...values: T[]): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, values);
  else list.push(...values);
}

function parseInput<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new EducateOsError("validation-failed", `${what} is invalid: ${z.prettifyError(result.error)}`);
  return result.data;
}
