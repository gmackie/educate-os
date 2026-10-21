// Records of integration sync runs, and the health derived from them. New for SchoolOS.
import { z } from "zod";

/** How much of the roster a sync reads. */
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

/** A failure a sync records by its code. The message is for the caller and is never stored. */
export class RosterSyncError extends Error {
  /** The code the run records. */
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = "RosterSyncError";
    this.code = code;
  }
}

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
   * The high-water `dateLastModified` the next delta starts from, as it stands after this run. A
   * failed run leaves it where it was; absent until a sync has seen a modification date.
   */
  cursor: z.iso.datetime().optional(),
  /** When the run started. */
  startedAt: z.iso.datetime(),
  /** When the run finished. */
  finishedAt: z.iso.datetime(),
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

/** What an integration is expected to achieve. */
export const IntegrationSla = z.strictObject({
  /** How old the last successful sync may be before the integration counts as stale. */
  maxStalenessMinutes: z.number().int().positive(),
});
/** An integration SLA. */
export type IntegrationSla = z.infer<typeof IntegrationSla>;

/** An integration's health, as an operator dashboard shows it. */
export interface IntegrationHealth {
  /**
   * `never-synced` until a run succeeds; then `stale` once the last success is older than the SLA
   * allows; else `degraded` while the latest run failed; else `healthy`.
   */
  status: "never-synced" | "stale" | "degraded" | "healthy";
  /** When the last successful run finished. */
  lastSuccessAt?: string;
  /** How long ago the last successful run finished, in minutes. */
  stalenessMinutes?: number;
  /** Failed runs since the last success. */
  consecutiveFailures: number;
  /** The error code of the latest run, when it failed. */
  lastErrorCode?: SyncErrorCode;
  /** Users the last successful run quarantined, which still wait for an administrator. */
  quarantineBacklog: number;
}

/**
 * Summarizes an integration's runs, in any order, as of `now`. Runs are ordered by when they
 * finished, so a late-recorded run is placed where it belongs.
 */
export function integrationHealth(
  runs: readonly IntegrationSyncRun[],
  sla: IntegrationSla,
  now: Date,
): IntegrationHealth {
  const { maxStalenessMinutes } = IntegrationSla.parse(sla);
  const ordered = z.array(IntegrationSyncRun).parse(runs)
    .toSorted((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const latest = ordered.at(-1);
  const lastSuccess = ordered.findLast((run) => run.outcome === "succeeded");
  const consecutiveFailures = ordered.length - 1 - ordered.findLastIndex((run) => run.outcome === "succeeded");
  const lastErrorCode = latest?.outcome === "failed" ? latest.errorCode : undefined;
  if (lastSuccess === undefined) {
    return {
      status: "never-synced",
      consecutiveFailures,
      ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      quarantineBacklog: 0,
    };
  }
  const stalenessMinutes = Math.max(0, Math.floor((now.getTime() - Date.parse(lastSuccess.finishedAt)) / 60_000));
  return {
    status: stalenessMinutes > maxStalenessMinutes ? "stale" : consecutiveFailures > 0 ? "degraded" : "healthy",
    lastSuccessAt: lastSuccess.finishedAt,
    stalenessMinutes,
    consecutiveFailures,
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    quarantineBacklog: lastSuccess.quarantined ?? 0,
  };
}
