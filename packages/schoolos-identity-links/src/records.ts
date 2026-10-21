import { z } from "zod";
import { AuditEventBase, DistrictId, PrincipalId, UtcTimestamp, WorkshopUserId } from "@schoolos/contracts";
import { IdentityLinkAuditEvent, PendingIdentityLink, PendingWorkshopUserAdoption } from "@schoolos/identity";

/**
 * Identifies one request in a district's identity-link control: a pending identity link or a
 * pending Workshop user adoption. Opaque and random, so it says nothing about who is being linked.
 * It follows the contracts' `<prefix>_<body>` ID shape and may move there later.
 */
export const IdentityRequestId = z
  .string()
  .regex(/^idr_[a-z0-9][a-z0-9-]{0,62}$/, "expected an identity request ID (idr_…)")
  .brand<"identityRequest">();
/** An identity request ID. */
export type IdentityRequestId = z.infer<typeof IdentityRequestId>;

/** A fresh, random {@link IdentityRequestId}. */
export function newIdentityRequestId(): IdentityRequestId {
  return IdentityRequestId.parse(`idr_${crypto.randomUUID()}`);
}

/**
 * The audit record of an administrator's decision on a Workshop user adoption. Like
 * `IdentityLinkAuditEvent` it names identifiers only: never the email the adoption was found by.
 */
export const WorkshopUserAdoptionAuditEvent = AuditEventBase.extend({
  action: z.enum(["workshop-user-adoption.confirmed", "workshop-user-adoption.rejected"]),
  target: z.strictObject({ principalId: PrincipalId, workshopUserId: WorkshopUserId }),
});
/** A Workshop user adoption audit event. */
export type WorkshopUserAdoptionAuditEvent = z.infer<typeof WorkshopUserAdoptionAuditEvent>;

/** Any audit event the identity-link control persists. */
export type IdentityControlAuditEvent = IdentityLinkAuditEvent | WorkshopUserAdoptionAuditEvent;

/**
 * A confirmed adoption's instruction to the kernel: the data of the email-keyed Workshop user
 * `workshopUserId` now belongs to `principalId`, and is to be rebound to the principal-keyed user
 * without deleting it. Recording the intent changes no Workshop data; the kernel rebind that acts
 * on it is separate work.
 */
export const WorkshopUserRebindIntent = z.strictObject({
  districtId: DistrictId,
  workshopUserId: WorkshopUserId,
  principalId: PrincipalId,
  /** The district administrator who confirmed the adoption. */
  confirmedBy: PrincipalId,
  confirmedAt: UtcTimestamp,
});
/** A Workshop user rebind intent. */
export type WorkshopUserRebindIntent = z.infer<typeof WorkshopUserRebindIntent>;

/**
 * One entry of a district's identity-link log. The log is append-only, and the state (what is
 * pending, what was decided, the audit trail) is folded from it by `IdentityLinkIndex`.
 *
 * - `link-requested`: a sign-in asked to link a new identity to an existing principal.
 * - `link-approval-started`: an administrator began approving it. The directory is written between
 *   this entry and `link-decided`, so a concurrent rejection cannot leave a linked identity
 *   recorded as rejected, and a retried approval can finish one that was interrupted.
 * - `link-approval-abandoned`: the approval failed a check against the directory (the identity was
 *   linked to someone else while it waited, say), so the request is pending again and can be
 *   rejected.
 * - `link-decided`: the approval or rejection, with its audit event.
 * - `adoption-proposed`: the migration plan proposed adopting an email-keyed Workshop user.
 * - `adoption-decided`: the confirmation or rejection, with its audit event, and on confirmation
 *   the rebind intent.
 */
export const IdentityLinkEntry = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("link-requested"), requestId: IdentityRequestId, link: PendingIdentityLink }),
  z.strictObject({ type: z.literal("link-approval-started"), requestId: IdentityRequestId, actorId: PrincipalId, at: UtcTimestamp }),
  z.strictObject({ type: z.literal("link-approval-abandoned"), requestId: IdentityRequestId, at: UtcTimestamp }),
  z.strictObject({ type: z.literal("link-decided"), requestId: IdentityRequestId, event: IdentityLinkAuditEvent }),
  z.strictObject({
    type: z.literal("adoption-proposed"),
    requestId: IdentityRequestId,
    adoption: PendingWorkshopUserAdoption,
    proposedAt: UtcTimestamp,
  }),
  z.strictObject({
    type: z.literal("adoption-decided"),
    requestId: IdentityRequestId,
    event: WorkshopUserAdoptionAuditEvent,
    /** Present exactly when the adoption was confirmed. */
    rebindIntent: WorkshopUserRebindIntent.optional(),
  }),
]);
/** An identity-link log entry. */
export type IdentityLinkEntry = z.infer<typeof IdentityLinkEntry>;

/** Where a request stands. `approving` is an approval that has begun and not yet finished. */
export type IdentityRequestStatus = "pending" | "approving" | "approved" | "rejected";

/** A request as an administrator reviews it. */
export type IdentityRequest =
  | {
    kind: "identity-link";
    requestId: IdentityRequestId;
    status: IdentityRequestStatus;
    link: PendingIdentityLink;
  }
  | {
    kind: "workshop-user-adoption";
    requestId: IdentityRequestId;
    status: IdentityRequestStatus;
    adoption: PendingWorkshopUserAdoption;
    proposedAt: UtcTimestamp;
  };
