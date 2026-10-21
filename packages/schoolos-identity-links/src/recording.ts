import { SchoolOsError } from "@schoolos/contracts";
import { MigrationPlan, PendingIdentityLink } from "@schoolos/identity";
import { newIdentityRequestId, type IdentityRequestId } from "./records.ts";
import type { IdentityLinkStore } from "./store.ts";

/**
 * Records a pending identity link for a district administrator to decide, as a sign-in that
 * `requestIdentityLink` accepted asks. Idempotent while the request is open: the same principal and
 * identity again returns the open request's ID and appends nothing, so signing in repeatedly cannot
 * flood the administrators' queue. Once it is decided, a later sign-in opens a new request.
 *
 * This is what the sign-in seam's `recordPendingLink` delegates to. It only records: the identity
 * resolves to no one until an administrator approves the link.
 *
 * Throws `SchoolOsError("validation-failed")` for a malformed link or one of another district.
 */
export async function recordPendingIdentityLink(store: IdentityLinkStore, link: unknown): Promise<IdentityRequestId> {
  const parsed = PendingIdentityLink.safeParse(link);
  if (!parsed.success) throw new SchoolOsError("validation-failed", "The pending identity link is malformed.");
  const pending = parsed.data;
  if (pending.districtId !== store.districtId) throw new SchoolOsError("validation-failed", "The pending identity link belongs to another district.");
  return store.transact((index) => {
    const open = index.openLinkRequest(pending);
    if (open !== undefined) return { append: [], result: open };
    const requestId = newIdentityRequestId();
    return { append: [{ type: "link-requested", requestId, link: pending }], result: requestId };
  });
}

/**
 * Records the pending adoption of every `exact-single` entry of a migration plan, in one step.
 * Skips a Workshop user whose adoption is already open or already confirmed, so the plan can be
 * re-run as the roster changes. Every other outcome (`ambiguous`, `cross-district`, `unmatched`)
 * proposes nothing, and no email from the plan is stored. Returns the new requests' IDs.
 *
 * Throws `SchoolOsError("validation-failed")` for a malformed plan or one of another district.
 */
export async function recordPendingAdoptions(store: IdentityLinkStore, plan: unknown, proposedAt: string): Promise<IdentityRequestId[]> {
  const parsed = MigrationPlan.safeParse(plan);
  if (!parsed.success) throw new SchoolOsError("validation-failed", "The migration plan is malformed.");
  if (parsed.data.districtId !== store.districtId) throw new SchoolOsError("validation-failed", "The migration plan belongs to another district.");
  return store.transact((index) => {
    const append = parsed.data.entries.flatMap((entry) => {
      if (entry.outcome !== "exact-single") return [];
      const { pendingAdoption } = entry;
      const known = index.openAdoptionRequest(pendingAdoption.workshopUserId) !== undefined
        || index.adoptedInto(pendingAdoption.workshopUserId) !== undefined;
      return known ? [] : [{ type: "adoption-proposed" as const, requestId: newIdentityRequestId(), adoption: pendingAdoption, proposedAt }];
    });
    return { append, result: append.map((entry) => entry.requestId) };
  });
}
