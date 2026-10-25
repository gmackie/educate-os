import type { Caller, Principal, PrincipalId } from "@educateos/contracts";
import type { AcademicDirectory, DepartedStatus } from "@educateos/academics";
import type { WorkspaceDirectory } from "./directory.ts";

/** What {@link transitionPrincipal} changed. */
export interface PrincipalTransitionResult {
  /** The principal as now stored. */
  principal: Principal;
  /** Live course grants revoked by the reconciliation that followed. */
  grantsRevoked: number;
}

/**
 * Graduates or deactivates a principal and ends their class access (SCHO-145), the service behind
 * the district app's admin lifecycle route. Two steps, each authorized and audited for `caller`:
 *
 * 1. `AcademicDirectory.setPrincipalStatus` moves them to `status`, deleting nothing, and is
 *    refused with `conflict` where another system owns principals.
 * 2. `WorkspaceDirectory.reconcileCourseGrants` revokes their live course grants and cancels their
 *    course AI funding. Their personal and course workspaces, and the work in them, are kept under
 *    the district's retention policy.
 *
 * The policy engine already gives a principal that is not active no roles, so their class requests
 * are denied from the first decision after step 1. A retry after a failed step 2 is safe: step 1
 * changes nothing the second time, and step 2 is idempotent.
 */
export async function transitionPrincipal(
  services: { academics: AcademicDirectory; workspaces: WorkspaceDirectory },
  caller: Caller,
  principalId: PrincipalId,
  status: DepartedStatus,
): Promise<PrincipalTransitionResult> {
  const principal = await services.academics.setPrincipalStatus(caller, principalId, status);
  const { revoked } = await services.workspaces.reconcileCourseGrants(caller);
  return { principal, grantsRevoked: revoked };
}
