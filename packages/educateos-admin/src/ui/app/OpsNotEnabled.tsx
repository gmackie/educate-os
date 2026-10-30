import { Banner } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import { AdminApiError } from "./client.ts";

/** The admin API's code for a workspace whose district doesn't serve /api/ops yet (SCHO-263). */
export const OPS_NOT_ENABLED = "ops-not-enabled";

/** Whether a failed call means the workspace's district has no ops API yet. */
export const isOpsNotEnabled = (error: unknown): boolean => error instanceof AdminApiError && error.code === OPS_NOT_ENABLED;

/**
 * A notice, not an error: the district is fine, it just doesn't serve the ops API (yet), so there
 * is nothing to show here until its administrator turns it on.
 */
export const OpsNotEnabled = () => (
  <Banner
    variant="default"
    icon={<Info weight="fill" />}
    title="Operations not enabled for this workspace"
    description="Its district doesn't answer this admin's operations API (/api/ops) yet. Health, Cloudflare stats, people and devices appear here once the district turns it on from its own /admin, under Operations."
  />
);
