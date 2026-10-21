// The dry-run drift report a district reviews before approving a release offer (roadmap §9.1
// step 7): the installer's own plan for the verified manifest, against the account as it is now.
import type { DriftReport } from "@schoolos/releases";
import { install, type InstallOptions } from "./installer.ts";

/**
 * Plans an install of the release without changing anything and reports the drift for the
 * district's approval (`DistrictReleaseManager.approve` and `authorizeApply` in
 * `@schoolos/releases`). `manifestSha256` is the digest of the verified manifest, from its signed
 * statement, so the report is bound to exactly the bytes that will be installed.
 */
export async function dryRunDrift(
  options: Omit<InstallOptions, "dryRun" | "registry" | "onStep">,
  manifestSha256: string,
): Promise<DriftReport> {
  const report = await install({ ...options, dryRun: true });
  const steps = report.plan?.steps ?? [];
  return {
    releaseId: options.manifest.releaseId,
    manifestSha256,
    ready: report.status === "planned",
    changes: steps.flatMap((step) =>
      step.action === "noop" ? [] : [{ resource: step.key, kind: step.kind, action: step.action, reason: truncate(step.reason) }]),
    pendingMigrations: steps.flatMap((step) => step.pendingMigrations ?? []),
  };
}

/** The drift report's reason limit. A Worker step can list many binding changes. */
const MAX_REASON_LENGTH = 500;

function truncate(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}
