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
}).refine((run) => (run.outcome === "failed") === (run.errorCode !== undefined), {
  message: "a failed run has an error code and a successful one does not",
  path: ["errorCode"],
});
/** An integration sync run. */
export type IntegrationSyncRun = z.infer<typeof IntegrationSyncRun>;
