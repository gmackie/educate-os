import { z } from "zod";
import { UtcTimestamp } from "./primitives.ts";

/** How much of a roster a sync reads. */
export const SyncMode = z.enum([
  /** The whole roster. A record it does not list is treated as gone. */
  "complete",
  /** Only the records changed since the cursor. A record it does not list is left as it is. */
  "delta",
]);
/** A sync mode. */
export type SyncMode = z.infer<typeof SyncMode>;

/**
 * Why a sync failed. Codes are opaque on purpose: a run record is shown on dashboards and kept
 * indefinitely, so it never carries a message that could hold a token, a secret or roster data.
 */
export const SyncErrorCode = z.enum([
  /** The source refused the credentials or the token. */
  "auth-failed",
  /** The source could not be reached, timed out or kept failing. */
  "source-unavailable",
  /** The source kept rate limiting the sync. */
  "rate-limited",
  /** A response was not what the specification defines. */
  "invalid-response",
  /** A response, or a whole collection, was over the size limit. */
  "response-too-large",
  /** Paging returned duplicates, skipped records, or changed its total part way through. */
  "inconsistent-paging",
  /** The feed was read but has errors, or would break the directory, so nothing was applied. */
  "feed-rejected",
  /** The source cannot supply a delta. */
  "delta-unsupported",
  /** A delta was asked for before any complete sync succeeded, so there is nothing to apply it to. */
  "no-baseline",
  /**
   * The feed would deactivate more of the roster than the removal hold allows, so it waits for an
   * administrator to approve it.
   */
  "removal-held",
  /** Anything else. */
  "internal-error",
]);
/** A sync error code. */
export type SyncErrorCode = z.infer<typeof SyncErrorCode>;

/** How one kind of record changed in a run. */
export const EntityCounts = z.strictObject({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
});
/** Entity counts. */
export type EntityCounts = z.infer<typeof EntityCounts>;

/** How each kind of record changed in a run. All zero for a run that failed or changed nothing. */
export const SyncCounts = z.strictObject({
  schools: EntityCounts,
  terms: EntityCounts,
  courses: EntityCounts,
  offerings: EntityCounts,
  principals: EntityCounts,
  enrollments: EntityCounts,
  roleAssignments: z.strictObject({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }),
});
/** Sync counts. */
export type SyncCounts = z.infer<typeof SyncCounts>;

/** One run of an integration's sync. */
export const IntegrationSyncRun = z.strictObject({
  /** The run's ID, chosen by the caller. */
  id: z.string().min(1).max(128),
  /** What the run read. */
  mode: SyncMode,
  /**
   * The high-water modification date the next delta starts from, as it stands after this run. A
   * failed run leaves it where it was; absent until a sync has seen a modification date.
   */
  cursor: UtcTimestamp.optional(),
  /** When the run started. */
  startedAt: UtcTimestamp,
  /** When the run finished. */
  finishedAt: UtcTimestamp,
  /** What the run changed. */
  counts: SyncCounts,
  /**
   * Roster users held back for an administrator to resolve. Absent when the run failed before it
   * could map the feed.
   */
  quarantined: z.number().int().nonnegative().optional(),
  /** Whether the run applied its feed. A run that applied a feed with no changes succeeded. */
  outcome: z.enum(["succeeded", "failed"]),
  /** Why the run failed. Present exactly when it did. */
  errorCode: SyncErrorCode.optional(),
  /**
   * For a run that failed `removal-held`, what its feed would have deactivated: counts, and the
   * fingerprint an administrator's approval names. Counts and a digest only, never the records.
   */
  held: z.strictObject({
    principals: z.strictObject({ deactivated: z.int().nonnegative(), active: z.int().nonnegative() }),
    enrollments: z.strictObject({ deactivated: z.int().nonnegative(), active: z.int().nonnegative() }),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  }).optional(),
}).refine((run) => (run.outcome === "failed") === (run.errorCode !== undefined), {
  message: "a failed run has an error code and a successful one does not",
  path: ["errorCode"],
}).refine((run) => (run.errorCode === "removal-held") === (run.held !== undefined), {
  message: "a run held for a removal says what it held, and no other run does",
  path: ["held"],
});
/** An integration sync run. */
export type IntegrationSyncRun = z.infer<typeof IntegrationSyncRun>;

/**
 * Which roster field holds the subject the district's IdP asserts for each user. Email is not an
 * option: it is not a stable or unique key (ADR-0003).
 */
export const IdpSubjectField = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("username") }),
  z.strictObject({ field: z.literal("identifier") }),
  /** The identifier of the `userIds` entry with this type, such as `{idp:nf-0001}` for `idp`. */
  z.strictObject({ field: z.literal("userIds"), type: z.string().min(1).max(64) }),
]);
/** An IdP subject field. */
export type IdpSubjectField = z.infer<typeof IdpSubjectField>;

/**
 * How a district's roster relates to its IdP: the issuer that asserts the roster's subjects, which
 * the district must trust, and where each user's subject is. It is configuration (stored in a
 * configuration revision), never a credential.
 */
export const RosterIdentityMapping = z.strictObject({
  /** The issuer that asserts the subjects in the roster. */
  issuer: z.url({ protocol: /^https$/ }),
  /** Where each user's subject is. */
  subject: IdpSubjectField,
});
/** A roster identity mapping. */
export type RosterIdentityMapping = z.infer<typeof RosterIdentityMapping>;

/**
 * When a roster integration syncs: a delta every `deltaEveryMinutes`, where the source can read
 * one, and a complete sync every `completeEveryHours`, which is also how deletions a delta never
 * reports (records removed rather than marked `tobedeleted`) are caught.
 */
export const RosterSyncSchedule = z.strictObject({
  deltaEveryMinutes: z.int().min(5).max(24 * 60),
  completeEveryHours: z.int().min(1).max(24 * 31),
});
/** A roster sync schedule. */
export type RosterSyncSchedule = z.infer<typeof RosterSyncSchedule>;

/**
 * The threshold of a roster integration's large-removal hold (IF-11), as a configuration revision
 * stores it under `rostering.removalHold`. A sync is held for an administrator, not applied, when it
 * would deactivate more than `maxFraction` of the roster's active principals, or of its active
 * enrollments, and at least `minCount` of them: a truncated export or a sync scoped to the wrong
 * schools looks exactly like most of a district leaving. A `maxFraction` of 1 never holds.
 *
 * It measures one sync at a time, so removals spread over several syncs below the threshold are
 * never held.
 */
export const RemovalHold = z.strictObject({
  maxFraction: z.number().min(0).max(1),
  minCount: z.int().min(1),
});
/** A removal hold threshold. */
export type RemovalHold = z.infer<typeof RemovalHold>;

/**
 * Which Clever district a Clever roster integration reads, as a configuration revision stores it
 * under `rostering.clever`. It names no credential: the district-app token Clever issues for the
 * district is a Worker secret, and the sync refuses a token that reads any other district.
 */
export const CleverRosterConnection = z.strictObject({
  /** Clever's ID of the district. */
  districtId: z.string().regex(/^[0-9a-f]{24}$/, "expected a Clever district ID (24 hex digits)"),
  /** Records asked for per page. Clever allows up to 10,000; 1,000 when absent. */
  pageSize: z.int().min(1).max(10_000).optional(),
});
/** A Clever roster connection. */
export type CleverRosterConnection = z.infer<typeof CleverRosterConnection>;
