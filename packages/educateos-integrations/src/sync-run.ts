// Records of integration sync runs, and the health derived from them. New for EducateOS.
import { IntegrationSyncRun, SyncErrorCode } from "@educateos/contracts";
import { z } from "zod";

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
