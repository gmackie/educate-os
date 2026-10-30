// How the roster sync screen words a sync's runs: what failed, what changed and how healthy the
// integration is. A run carries codes and counts only, never roster data, so everything here is
// built from those.
import type { RouteResponse } from "@educateos/api-client";
import { count } from "../app/labels.ts";

/** The roster sync's status, as the district reports it. */
export type RosterSyncStatus = RouteResponse<"admin.rosterSyncStatus">;
/** One run of the roster sync. */
export type SyncRun = RosterSyncStatus["runs"][number];
/** What running a sync did. */
export type SyncRunResult = RouteResponse<"admin.runRosterSync">;
/** How much of the roster a sync reads. */
export type SyncMode = SyncRun["mode"];
type SyncHealth = NonNullable<RosterSyncStatus["health"]>;
type EntityCounts = SyncRun["counts"]["principals"];

/** A sync mode's name: "Complete sync" or "Delta sync". */
export const modeName = (mode: SyncMode): string => (mode === "complete" ? "Complete sync" : "Delta sync");

/** Why a run failed, in a sentence naming `provider`, from its error code. */
export function failureReason(code: NonNullable<SyncRun["errorCode"]>, provider: string): string {
  switch (code) {
    case "auth-failed": return `${provider} refused this district's credentials.`;
    case "source-unavailable": return `${provider} could not be reached, or kept failing.`;
    case "rate-limited": return `${provider} kept limiting how fast the roster could be read.`;
    case "invalid-response": return `${provider} sent a response that does not follow its specification.`;
    case "response-too-large": return `${provider} sent more than one sync can read at once.`;
    case "inconsistent-paging": return `${provider} returned the roster inconsistently: records were repeated or skipped between pages.`;
    case "feed-rejected": return "The roster has problems that would break the directory, so nothing was applied.";
    case "delta-unsupported": return `${provider} cannot send only what changed. Run a complete sync instead.`;
    case "no-baseline": return "A delta sync needs a complete sync to have succeeded first. Run a complete sync.";
    case "removal-held": return "It would deactivate more of the roster than the removal hold allows, so it waits for an administrator's approval.";
    case "internal-error": return "Something went wrong in EducateOS. Nothing was applied; run the sync again.";
  }
}

/** The integration's health, as a badge shows it. */
export const HEALTH: Record<SyncHealth["status"], { label: string; variant: "success" | "warning" | "error" | "neutral" }> = {
  healthy: { label: "Healthy", variant: "success" },
  degraded: { label: "Last sync failed", variant: "warning" },
  stale: { label: "Out of date", variant: "error" },
  "never-synced": { label: "Never synced", variant: "neutral" },
};

/** The record types a run counts, in the order the screen lists them. */
export const RECORD_TYPES = [
  ["principals", "People"],
  ["offerings", "Classes"],
  ["enrollments", "Enrollments"],
  ["courses", "Courses"],
  ["terms", "Terms"],
  ["schools", "Schools"],
] as const;

/** How one record type changed, such as "1 added, 2 updated", or "No change". */
export function changeSummary(c: EntityCounts): string {
  const parts = [
    c.added > 0 ? `${c.added.toLocaleString("en-US")} added` : undefined,
    c.updated > 0 ? `${c.updated.toLocaleString("en-US")} updated` : undefined,
    c.deactivated > 0 ? `${c.deactivated.toLocaleString("en-US")} deactivated` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "No change" : parts.join(", ");
}

/** Every record a run added, updated or deactivated, and role grants and removals. */
export function totalChanges(counts: SyncRun["counts"]): number {
  return RECORD_TYPES.reduce((n, [key]) => n + counts[key].added + counts[key].updated + counts[key].deactivated, 0)
    + counts.roleAssignments.added + counts.roleAssignments.removed;
}

/** A successful run in a sentence: what it changed and who it held back. */
export function runSummary(run: SyncRun, grantsRevoked?: number): string {
  const changes = totalChanges(run.counts);
  return [
    changes === 0 ? "The roster already matched; nothing changed." : `${count(changes, "change")} applied.`,
    run.quarantined === undefined || run.quarantined === 0 ? undefined : `${count(run.quarantined, "person", "people")} held for review.`,
    grantsRevoked === undefined || grantsRevoked === 0 ? undefined : `${count(grantsRevoked, "course access grant")} revoked from people the roster dropped.`,
  ].filter((part) => part !== undefined).join(" ");
}

/** A reason from the district (lower case, no full stop) as a sentence. */
export const sentence = (reason: string): string => `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${/[.!?]$/.test(reason) ? "" : "."}`;
