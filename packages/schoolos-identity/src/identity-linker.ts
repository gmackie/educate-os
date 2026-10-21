import { z } from "zod";
import {
  AuditEventBase,
  checkDirectoryIntegrity,
  CredentialKind,
  DistrictId,
  ExternalIdentity,
  externalIdentityKey,
  PrincipalId,
  SchoolOsError,
  WorkshopUserId,
  type DistrictDirectorySnapshot,
  type Principal,
  type VerifiedIdentity,
} from "@schoolos/contracts";
import { credentialMatchesPrincipal } from "./verified-identity.ts";

/**
 * A request to link a new external identity to an existing principal. It changes nothing until a
 * district administrator approves it ({@link approveIdentityLink}), and approval re-checks it
 * against the directory as it is then, so a request that went stale while waiting cannot apply.
 */
export const PendingIdentityLink = z.strictObject({
  districtId: DistrictId,
  principalId: PrincipalId,
  identity: ExternalIdentity,
  /** The kind of credential the identity was verified from. It must suit the principal's kind. */
  credential: CredentialKind,
  requestedAt: z.iso.datetime(),
  /** The email-keyed Workshop user the request came from, when it arose during migration. */
  workshopUserId: WorkshopUserId.optional(),
});
/** A pending identity link. */
export type PendingIdentityLink = z.infer<typeof PendingIdentityLink>;

/** An administrator's decision on a {@link PendingIdentityLink}. */
export const IdentityLinkDecision = z.strictObject({
  /** The deciding principal. It must hold `district-admin` at district scope in the directory. */
  actorId: PrincipalId,
  decidedAt: z.iso.datetime(),
});
/** An identity link decision. */
export type IdentityLinkDecision = z.infer<typeof IdentityLinkDecision>;

/**
 * The audit record of an identity link decision. It names principals and the identity link only:
 * no email or other profile data, so the audit log never becomes a second copy of the directory.
 */
export const IdentityLinkAuditEvent = AuditEventBase.extend({
  action: z.enum(["identity-link.approved", "identity-link.rejected"]),
  target: z.strictObject({ principalId: PrincipalId, identity: ExternalIdentity }),
});
/** An identity link audit event. */
export type IdentityLinkAuditEvent = z.infer<typeof IdentityLinkAuditEvent>;

/** What approving a link produces: the directory to store and the event to audit. */
export interface ApprovedIdentityLink {
  /** The new directory snapshot. It passes `checkDirectoryIntegrity`. */
  directory: DistrictDirectorySnapshot;
  /** The audit event recording the approval. */
  event: IdentityLinkAuditEvent;
}

/** What a caller supplies to request a link. */
export interface IdentityLinkRequest {
  /** The principal the identity should be linked to. */
  principalId: PrincipalId;
  /** The verified identity to link. Its district is the directory's. */
  identity: VerifiedIdentity;
  /** When the request was made, as an ISO 8601 date-time. */
  requestedAt: string;
  /** The email-keyed Workshop user the request came from, during migration. */
  workshopUserId?: WorkshopUserId;
}

function requireIntact(directory: DistrictDirectorySnapshot): void {
  if (checkDirectoryIntegrity(directory).length > 0) {
    throw new SchoolOsError("unavailable", "The district directory failed its integrity checks.");
  }
}

function parseOrFail<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SchoolOsError("validation-failed", `The ${what} is malformed.`);
  return parsed.data;
}

/**
 * Checks that `identity` may become a link of `principalId` in `directory` now, and returns that
 * principal. Shared by request and approval, so approval re-runs every check.
 */
function checkLinkable(
  directory: DistrictDirectorySnapshot,
  principalId: PrincipalId,
  identity: ExternalIdentity,
  credential: CredentialKind,
): Principal {
  const districtId = directory.district.id;
  if (identity.districtId !== districtId) {
    throw new SchoolOsError("forbidden", "The identity belongs to another district.");
  }
  const principal = directory.principals.find((p) => p.id === principalId);
  if (principal === undefined) throw new SchoolOsError("not-found", "No such principal in this district.");
  if (!directory.district.trustedIssuers.includes(identity.issuer)) {
    throw new SchoolOsError("forbidden", "This district does not trust the identity's issuer.");
  }
  if (!credentialMatchesPrincipal(credential, principal.kind)) {
    throw new SchoolOsError("validation-failed", `A ${credential} credential cannot be linked to a ${principal.kind} principal.`);
  }
  const key = externalIdentityKey(identity);
  const owner = directory.principals.find((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key));
  if (owner !== undefined) {
    throw new SchoolOsError(
      "conflict",
      owner.id === principalId ? "The identity is already linked to this principal." : "The identity is already linked to another principal.",
    );
  }
  return principal;
}

/** Throws unless `actorId` holds `district-admin` at district scope in `directory`. */
function requireDistrictAdmin(directory: DistrictDirectorySnapshot, actorId: PrincipalId): void {
  const districtId = directory.district.id;
  const isAdmin = directory.roleAssignments.some((a) =>
    a.principalId === actorId && a.role === "district-admin"
      && a.scope.level === "district" && a.scope.districtId === districtId);
  if (!isAdmin) throw new SchoolOsError("forbidden", "Only a district administrator can decide identity links.");
}

/**
 * Records a request to link a verified identity to an existing principal. Refuses (throws
 * `SchoolOsError`) when the principal is unknown, the issuer is untrusted, the credential kind does
 * not suit the principal, or the identity is already linked to any principal.
 */
export function requestIdentityLink(directory: DistrictDirectorySnapshot, request: IdentityLinkRequest): PendingIdentityLink {
  requireIntact(directory);
  const pending = parseOrFail(PendingIdentityLink, {
    districtId: directory.district.id,
    principalId: request.principalId,
    identity: { districtId: directory.district.id, issuer: request.identity.issuer, subject: request.identity.subject },
    credential: request.identity.credential,
    requestedAt: request.requestedAt,
    ...(request.workshopUserId === undefined ? {} : { workshopUserId: request.workshopUserId }),
  }, "link request");
  checkLinkable(directory, pending.principalId, pending.identity, pending.credential);
  return pending;
}

/**
 * Approves a pending link as `decision.actorId`, a district administrator. Every request check is
 * re-run against `directory` first, so this also refuses to take an identity that was linked to
 * someone else while the request waited. Returns a new snapshot (the input is not modified) and the
 * audit event.
 */
export function approveIdentityLink(
  directory: DistrictDirectorySnapshot,
  pendingLink: PendingIdentityLink,
  decision: IdentityLinkDecision,
): ApprovedIdentityLink {
  requireIntact(directory);
  const pending = parseOrFail(PendingIdentityLink, pendingLink, "pending link");
  const { actorId, decidedAt } = parseOrFail(IdentityLinkDecision, decision, "decision");
  if (pending.districtId !== directory.district.id) throw new SchoolOsError("not-found", "No such pending link in this district.");
  requireDistrictAdmin(directory, actorId);
  checkLinkable(directory, pending.principalId, pending.identity, pending.credential);

  const next: DistrictDirectorySnapshot = {
    ...directory,
    principals: directory.principals.map((p) =>
      p.id === pending.principalId ? { ...p, externalIdentities: [...p.externalIdentities, pending.identity] } : p),
  };
  if (checkDirectoryIntegrity(next).length > 0) {
    // checkLinkable rules out every way a single added link could break integrity.
    throw new Error("approving an identity link produced an inconsistent directory");
  }
  return { directory: next, event: auditEvent(directory, "identity-link.approved", actorId, pending, decidedAt) };
}

/**
 * Rejects a pending link as `decision.actorId`, a district administrator. The directory is
 * unchanged; the returned audit event is the only record.
 */
export function rejectIdentityLink(
  directory: DistrictDirectorySnapshot,
  pendingLink: PendingIdentityLink,
  decision: IdentityLinkDecision,
): IdentityLinkAuditEvent {
  const pending = parseOrFail(PendingIdentityLink, pendingLink, "pending link");
  const { actorId, decidedAt } = parseOrFail(IdentityLinkDecision, decision, "decision");
  if (pending.districtId !== directory.district.id) throw new SchoolOsError("not-found", "No such pending link in this district.");
  requireDistrictAdmin(directory, actorId);
  return auditEvent(directory, "identity-link.rejected", actorId, pending, decidedAt);
}

function auditEvent(
  directory: DistrictDirectorySnapshot,
  action: IdentityLinkAuditEvent["action"],
  actorId: PrincipalId,
  pending: PendingIdentityLink,
  at: string,
): IdentityLinkAuditEvent {
  return {
    districtId: directory.district.id,
    actor: { principalId: actorId },
    action,
    target: { principalId: pending.principalId, identity: pending.identity },
    at,
  };
}
