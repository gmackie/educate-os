// The district's Cron Triggers (SCHO-189), shared by cloudflare.config.ts (which declares them) and
// the Worker's scheduled handler (which tells them apart by their expression).

/** Every hour at :07: brings notifications up to date and emails those owed an email. */
export const NOTIFICATION_CRON = "7 * * * *";

/**
 * Sundays at 14:00 UTC: the weekly family digest for the week that starts the next morning. The
 * send ledger makes a rerun in the same week a no-op.
 */
export const DIGEST_CRON = "0 14 * * SUN";

/** The job a Cron Trigger runs, by its expression. */
export type DistrictJob = "notifications" | "digest";

/** The job `cron` names, or undefined for an expression the district does not schedule. */
export function jobForCron(cron: string): DistrictJob | undefined {
  if (cron === NOTIFICATION_CRON) return "notifications";
  if (cron === DIGEST_CRON) return "digest";
  return undefined;
}
