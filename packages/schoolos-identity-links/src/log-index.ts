import { externalIdentityKey, SchoolOsError, type DistrictId, type PrincipalId, type WorkshopUserId } from "@schoolos/contracts";
import type { PendingIdentityLink } from "@schoolos/identity";
import {
  IdentityLinkEntry,
  type IdentityControlAuditEvent,
  type IdentityRequest,
  type IdentityRequestId,
  type IdentityRequestStatus,
  type WorkshopUserRebindIntent,
} from "./records.ts";

const OPEN: readonly IdentityRequestStatus[] = ["pending", "approving"];

const linkKey = (link: PendingIdentityLink) => JSON.stringify([link.principalId, externalIdentityKey(link.identity)]);

function refuse(message: string): never {
  throw new SchoolOsError("conflict", message);
}

/**
 * One district's identity-link log folded into its current state: every request with its status,
 * the audit trail and the confirmed rebind intents.
 *
 * {@link apply} is the only way state changes, and it enforces every transition, so no store can
 * commit an entry that breaks them (a store stages each step on a copy first):
 *
 * - every entry belongs to the index's district;
 * - a request ID is used once, and at most one open request exists per `(principal, identity)` link
 *   and per Workshop user;
 * - a link is approved only after its approval started, and rejected only while still pending (an
 *   approval that failed its checks is abandoned, which makes it pending again);
 * - an adoption is decided once, a confirmation always carries its rebind intent and a rejection
 *   never does, and a Workshop user is adopted into at most one principal, which adopts at most one
 *   Workshop user;
 * - a decision's audit event names exactly the request's principal and identity or Workshop user.
 */
export class IdentityLinkIndex {
  /** The district this log belongs to. */
  readonly districtId: DistrictId;
  readonly #entries: IdentityLinkEntry[] = [];
  readonly #requests = new Map<IdentityRequestId, IdentityRequest>();
  readonly #openLinks = new Map<string, IdentityRequestId>();
  readonly #openAdoptions = new Map<WorkshopUserId, IdentityRequestId>();
  readonly #adoptedUsers = new Map<WorkshopUserId, PrincipalId>();
  readonly #adoptingPrincipals = new Set<PrincipalId>();
  readonly #events: IdentityControlAuditEvent[] = [];
  readonly #intents: WorkshopUserRebindIntent[] = [];

  /** Folds `entries` in order. Throws as {@link apply} does if any is out of place. */
  constructor(districtId: DistrictId, entries: readonly IdentityLinkEntry[] = []) {
    this.districtId = districtId;
    for (const entry of entries) this.apply(entry);
  }

  /** Every entry, in append order. */
  get entries(): readonly IdentityLinkEntry[] {
    return this.#entries;
  }

  /** A copy that can be changed without changing this index. */
  clone(): IdentityLinkIndex {
    return new IdentityLinkIndex(this.districtId, this.#entries);
  }

  /** A request in any status, or undefined if there is no such request. */
  request(requestId: IdentityRequestId): IdentityRequest | undefined {
    const request = this.#requests.get(requestId);
    return request === undefined ? undefined : structuredClone(request);
  }

  /** The requests still awaiting a decision (`pending` or `approving`), oldest first. */
  open(): IdentityRequest[] {
    return [...this.#requests.values()].filter((r) => OPEN.includes(r.status)).map((r) => structuredClone(r));
  }

  /** The open link request for exactly this principal and identity, if there is one. */
  openLinkRequest(link: PendingIdentityLink): IdentityRequestId | undefined {
    return this.#openLinks.get(linkKey(link));
  }

  /** The open adoption request for a Workshop user, if there is one. */
  openAdoptionRequest(workshopUserId: WorkshopUserId): IdentityRequestId | undefined {
    return this.#openAdoptions.get(workshopUserId);
  }

  /** The principal a Workshop user's adoption was confirmed into, if it was. */
  adoptedInto(workshopUserId: WorkshopUserId): PrincipalId | undefined {
    return this.#adoptedUsers.get(workshopUserId);
  }

  /** Whether a principal has already adopted a Workshop user. */
  hasAdopted(principalId: PrincipalId): boolean {
    return this.#adoptingPrincipals.has(principalId);
  }

  /** Every decision's audit event, in the order decided. */
  auditEvents(): IdentityControlAuditEvent[] {
    return structuredClone(this.#events);
  }

  /** Every confirmed adoption's rebind intent, in the order confirmed. */
  rebindIntents(): WorkshopUserRebindIntent[] {
    return structuredClone(this.#intents);
  }

  /**
   * Validates one entry against the current state and folds it in. Throws
   * `SchoolOsError("validation-failed")` for a malformed entry or one of another district, and
   * `SchoolOsError("conflict")` for one that breaks a transition. A throw changes nothing.
   */
  apply(input: IdentityLinkEntry): void {
    const parsed = IdentityLinkEntry.safeParse(input);
    if (!parsed.success) throw new SchoolOsError("validation-failed", "An identity-link log entry is malformed.");
    const entry = parsed.data;
    const district = districtOf(entry);
    if (district !== undefined && district !== this.districtId) {
      throw new SchoolOsError("validation-failed", "An identity-link log entry belongs to another district.");
    }

    switch (entry.type) {
      case "link-requested": {
        this.#requireNew(entry.requestId);
        const key = linkKey(entry.link);
        if (this.#openLinks.has(key)) refuse("This identity link is already awaiting a decision.");
        this.#requests.set(entry.requestId, { kind: "identity-link", requestId: entry.requestId, status: "pending", link: entry.link });
        this.#openLinks.set(key, entry.requestId);
        break;
      }
      case "link-approval-started": {
        const request = this.#link(entry.requestId);
        if (!OPEN.includes(request.status)) refuse("This identity link has already been decided.");
        request.status = "approving";
        break;
      }
      case "link-approval-abandoned": {
        const request = this.#link(entry.requestId);
        if (request.status !== "approving") refuse("Only an approval that has started can be abandoned.");
        request.status = "pending";
        break;
      }
      case "link-decided": {
        const request = this.#link(entry.requestId);
        const { event } = entry;
        const approved = event.action === "identity-link.approved";
        if (approved ? request.status !== "approving" : request.status !== "pending") {
          refuse(approved ? "An identity link is approved only after its approval has started." : "Only a pending identity link can be rejected.");
        }
        if (event.target.principalId !== request.link.principalId
          || externalIdentityKey(event.target.identity) !== externalIdentityKey(request.link.identity)) {
          refuse("The decision's audit event names a different link.");
        }
        request.status = approved ? "approved" : "rejected";
        this.#openLinks.delete(linkKey(request.link));
        this.#events.push(event);
        break;
      }
      case "adoption-proposed": {
        this.#requireNew(entry.requestId);
        const { workshopUserId } = entry.adoption;
        if (this.#openAdoptions.has(workshopUserId)) refuse("This Workshop user's adoption is already awaiting a decision.");
        if (this.#adoptedUsers.has(workshopUserId)) refuse("This Workshop user has already been adopted.");
        this.#requests.set(entry.requestId, {
          kind: "workshop-user-adoption",
          requestId: entry.requestId,
          status: "pending",
          adoption: entry.adoption,
          proposedAt: entry.proposedAt,
        });
        this.#openAdoptions.set(workshopUserId, entry.requestId);
        break;
      }
      case "adoption-decided": {
        const request = this.#requests.get(entry.requestId);
        if (request?.kind !== "workshop-user-adoption") refuse("No such Workshop user adoption.");
        if (request.status !== "pending") refuse("This Workshop user adoption has already been decided.");
        const { adoption } = request;
        const { event, rebindIntent } = entry;
        if (event.target.principalId !== adoption.principalId || event.target.workshopUserId !== adoption.workshopUserId) {
          refuse("The decision's audit event names a different adoption.");
        }
        const confirmed = event.action === "workshop-user-adoption.confirmed";
        if (confirmed) {
          if (rebindIntent === undefined
            || rebindIntent.districtId !== this.districtId
            || rebindIntent.principalId !== adoption.principalId
            || rebindIntent.workshopUserId !== adoption.workshopUserId
            || rebindIntent.confirmedBy !== event.actor.principalId) {
            refuse("A confirmed adoption must carry its own rebind intent.");
          }
          if (this.#adoptedUsers.has(adoption.workshopUserId)) refuse("This Workshop user has already been adopted.");
          if (this.#adoptingPrincipals.has(adoption.principalId)) refuse("This principal has already adopted a Workshop user.");
          this.#adoptedUsers.set(adoption.workshopUserId, adoption.principalId);
          this.#adoptingPrincipals.add(adoption.principalId);
          this.#intents.push(rebindIntent);
        } else if (rebindIntent !== undefined) {
          refuse("A rejected adoption records no rebind intent.");
        }
        request.status = confirmed ? "approved" : "rejected";
        this.#openAdoptions.delete(adoption.workshopUserId);
        this.#events.push(event);
        break;
      }
    }
    this.#entries.push(entry);
  }

  #requireNew(requestId: IdentityRequestId): void {
    if (this.#requests.has(requestId)) refuse("This identity request ID is already in use.");
  }

  #link(requestId: IdentityRequestId): Extract<IdentityRequest, { kind: "identity-link" }> {
    const request = this.#requests.get(requestId);
    if (request?.kind !== "identity-link") refuse("No such identity link request.");
    return request;
  }
}

/** The district an entry names, or undefined for one that can only name a request already logged. */
function districtOf(entry: IdentityLinkEntry): DistrictId | undefined {
  switch (entry.type) {
    case "link-requested":
      return entry.link.districtId;
    case "adoption-proposed":
      return entry.adoption.districtId;
    case "link-decided":
    case "adoption-decided":
      return entry.event.districtId;
    case "link-approval-started":
    case "link-approval-abandoned":
      return undefined;
  }
}
