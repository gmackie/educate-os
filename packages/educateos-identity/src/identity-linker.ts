import { z } from "zod";
import {
  AuditEventBase,
  checkDirectoryIntegrity,
  CredentialKind,
  DistrictId,
  ExternalIdentity,
  externalIdentityKey,
  PrincipalId,
  roleAssignmentInForce,
  EducateOsError,
  WorkshopUserId,
  type DistrictDirectorySnapshot,
  type VerifiedIdentity,
} from "@educateos/contracts";
import { credentialMatchesPrincipal } from "./verified-identity.ts";

/**
 * The principal a link creates when it is approved, for a person who has no principal yet. Only a
 * guardian is ever created this way (ADR-0012): students and staff come from the roster, and a
 * service principal is set up by an administrator. Its ID is chosen when the request is made, so a
 * guardian relationship recorded in the meantime can name it.
 */
export const NewPrincipal = z.strictObject({
  kind: z.literal("guardian"),
  displayName: z.string().trim().min(1).max(200),
});
/** A principal a link creates. */
export type NewPrincipal = z.infer<typeof NewPrincipal>;

/**
 * A request to link a new external identity to a principal: an existing one, or, with
 * `newPrincipal`, one its approval creates. It changes nothing until a district administrator
 * approves it ({@link approveIdentityLink}), and approval re-checks it against the directory as it
 * is then, so a request that went stale while waiting cannot apply.
 */
export const PendingIdentityLink = z.strictObject({
  districtId: DistrictId,
  /** The principal the identity is linked to. With `newPrincipal`, the ID the approval creates it under. */
  principalId: PrincipalId,
  /** Present when no principal exists yet and approving the link creates it (a guardian, ADR-0012). */
  newPrincipal: NewPrincipal.optional(),
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
    throw new EducateOsError("unavailable", "The district directory failed its integrity checks.");
  }
}

function parseOrFail<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EducateOsError("validation-failed", `The ${what} is malformed.`);
  return parsed.data;
}

/**
 * Checks that `identity` may become a link of `principalId` in `directory` now, and returns that
 * principal. Shared by request and approval, so approval re-runs every check.
 */
function checkLinkable(
  directory: DistrictDirectorySnapshot,
  link: Pick<PendingIdentityLink, "principalId" | "identity" | "credential" | "newPrincipal">,
): void {
  const { principalId, identity, credential } = link;
  const districtId = directory.district.id;
  if (identity.districtId !== districtId) {
    throw new EducateOsError("forbidden", "The identity belongs to another district.");
  }
  const principal = directory.principals.find((p) => p.id === principalId);
  if (link.newPrincipal === undefined && principal === undefined) throw new EducateOsError("not-found", "No such principal in this district.");
  if (principal !== undefined && principal.status !== "active") {
    throw new EducateOsError("forbidden", "This principal is not active.");
  }
  // A link that creates its principal must not take over one that exists under the chosen ID.
  if (link.newPrincipal !== undefined && principal !== undefined) throw new EducateOsError("conflict", "A principal with this ID already exists.");
  if (!directory.district.trustedIssuers.includes(identity.issuer)) {
    throw new EducateOsError("forbidden", "This district does not trust the identity's issuer.");
  }
  const kind = principal?.kind ?? link.newPrincipal!.kind;
  if (!credentialMatchesPrincipal(credential, kind)) {
    throw new EducateOsError("validation-failed", `A ${credential} credential cannot be linked to a ${kind} principal.`);
  }
  const key = externalIdentityKey(identity);
  const owner = directory.principals.find((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key));
  if (owner !== undefined) {
    throw new EducateOsError(
      "conflict",
      owner.id === principalId ? "The identity is already linked to this principal." : "The identity is already linked to another principal.",
    );
  }
}

/** Throws unless `actorId` holds `district-admin` at district scope in `directory` at `at`. */
function requireDistrictAdmin(directory: DistrictDirectorySnapshot, actorId: PrincipalId, at: string): void {
  const districtId = directory.district.id;
  const isAdmin = directory.principals.some((p) => p.id === actorId && p.status === "active")
    && directory.roleAssignments.some((a) =>
    a.principalId === actorId && a.role === "district-admin"
      && a.scope.level === "district" && a.scope.districtId === districtId
      && roleAssignmentInForce(a, new Date(at)));
  if (!isAdmin) throw new EducateOsError("forbidden", "Only a district administrator can decide identity links.");
}

/**
 * Records a request to link a verified identity to an existing principal. Refuses (throws
 * `EducateOsError`) when the principal is unknown, the issuer is untrusted, the credential kind does
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
  checkLinkable(directory, pending);
  return pending;
}

/** What a caller supplies to request a link that creates its principal. */
export interface NewPrincipalLinkRequest {
  /** The ID the principal is created under when the link is approved. No principal may hold it. */
  principalId: PrincipalId;
  /** The principal to create. */
  newPrincipal: NewPrincipal;
  /** The verified identity to link. Its district is the directory's. */
  identity: VerifiedIdentity;
  /** When the request was made, as an ISO 8601 date-time. */
  requestedAt: string;
}

/**
 * Records a request to link a verified identity to a principal that does not exist yet, which
 * approving the link creates (a guardian's first sign-in, ADR-0012). Refuses as
 * {@link requestIdentityLink} does, and also when a principal already holds `principalId`.
 */
export function requestNewPrincipalLink(directory: DistrictDirectorySnapshot, request: NewPrincipalLinkRequest): PendingIdentityLink {
  requireIntact(directory);
  const pending = parseOrFail(PendingIdentityLink, {
    districtId: directory.district.id,
    principalId: request.principalId,
    newPrincipal: request.newPrincipal,
    identity: { districtId: directory.district.id, issuer: request.identity.issuer, subject: request.identity.subject },
    credential: request.identity.credential,
    requestedAt: request.requestedAt,
  }, "link request");
  checkLinkable(directory, pending);
  return pending;
}

/**
 * Approves a pending link as `decision.actorId`, a district administrator. Every request check is
 * re-run against `directory` first, so this also refuses to take an identity that was linked to
 * someone else while the request waited. A link with `newPrincipal` creates that principal, active
 * and holding only this identity. Returns a new snapshot (the input is not modified) and the audit
 * event.
 */
export function approveIdentityLink(
  directory: DistrictDirectorySnapshot,
  pendingLink: PendingIdentityLink,
  decision: IdentityLinkDecision,
): ApprovedIdentityLink {
  requireIntact(directory);
  const pending = parseOrFail(PendingIdentityLink, pendingLink, "pending link");
  const { actorId, decidedAt } = parseOrFail(IdentityLinkDecision, decision, "decision");
  if (pending.districtId !== directory.district.id) throw new EducateOsError("not-found", "No such pending link in this district.");
  requireDistrictAdmin(directory, actorId, decidedAt);
  checkLinkable(directory, pending);

  const next: DistrictDirectorySnapshot = {
    ...directory,
    principals: pending.newPrincipal === undefined
      ? directory.principals.map((p) =>
        p.id === pending.principalId ? { ...p, externalIdentities: [...p.externalIdentities, pending.identity] } : p)
      : [...directory.principals, {
        id: pending.principalId,
        districtId: directory.district.id,
        kind: pending.newPrincipal.kind,
        status: "active",
        displayName: pending.newPrincipal.displayName,
        externalIdentities: [pending.identity],
      }],
  };
  if (checkDirectoryIntegrity(next).length > 0) {
    // checkLinkable rules out every way a single added link (or new principal) could break integrity.
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
  if (pending.districtId !== directory.district.id) throw new EducateOsError("not-found", "No such pending link in this district.");
  requireDistrictAdmin(directory, actorId, decidedAt);
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
