import {
  externalIdentityKey,
  SchoolOsError,
  type Action,
  type Caller,
  type DistrictDirectorySnapshot,
  type PrincipalId,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import { approveIdentityLink, IdentityLinkAuditEvent, rejectIdentityLink, type PendingIdentityLink } from "@schoolos/identity";
import type { PolicyDecider } from "@schoolos/policy";
import type { IdentityLinkIndex } from "./log-index.ts";
import {
  IdentityRequestId,
  type IdentityControlAuditEvent,
  type IdentityRequest,
  type WorkshopUserAdoptionAuditEvent,
  type WorkshopUserRebindIntent,
} from "./records.ts";
import type { IdentityLinkStore } from "./store.ts";

/** What an {@link IdentityLinkAdminService} works over. */
export interface IdentityLinkAdminOptions {
  /** The district's identity-link log. */
  store: IdentityLinkStore;
  /** The district's directory, which an approved link is written to. It must be the store's district. */
  directory: AcademicStore;
  /** The district's policy engine. Every call is authorized and audited through it. */
  policy: PolicyDecider;
  /** The clock decisions are stamped with. Defaults to the system clock. */
  now?: () => Date;
}

/** What deciding a request produced. */
export interface IdentityRequestOutcome {
  /** The request decided. */
  request: IdentityRequest;
  /** The persisted audit event. */
  event: IdentityControlAuditEvent;
  /** For a confirmed adoption, the persisted rebind intent the kernel will act on. */
  rebindIntent?: WorkshopUserRebindIntent;
}

const NOT_ALLOWED = "Only a district administrator can review identity links.";

/**
 * The district administrator's service over pending identity links and Workshop user adoptions:
 * list them, approve one, reject one. Every call is first decided by the district's policy engine
 * as an `identity-link` resource at district scope (`list` to list, `approve` to approve or
 * reject), which only `district-admin` holds; anyone else, or an administrator of another district,
 * is refused with `forbidden` and the refusal is audited by the engine.
 *
 * - **Approving a link** re-runs every check against the directory as it is now
 *   (`approveIdentityLink`), writes the new directory, then records the decision and its
 *   `IdentityLinkAuditEvent`. The approval is claimed in the log before the directory is written,
 *   so a concurrent rejection cannot leave a linked identity recorded as rejected, and repeating an
 *   interrupted approval finishes it.
 * - **Confirming an adoption** records a `WorkshopUserRebindIntent` with the audit event: the
 *   email-keyed Workshop user's data is to be rebound to the principal, never deleted. The kernel
 *   rebind acts on it separately; nothing here touches Workshop data.
 * - **Rejecting** either records only the decision and its audit event.
 *
 * A request that does not exist is `not-found`, and one already decided is `conflict`.
 */
export class IdentityLinkAdminService {
  readonly #store: IdentityLinkStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #now: () => Date;

  constructor(options: IdentityLinkAdminOptions) {
    this.#store = options.store;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#now = options.now ?? (() => new Date());
  }

  /** The requests awaiting a decision, oldest first. An approval that began and was interrupted is listed as `approving`. */
  async listPending(caller: Caller): Promise<IdentityRequest[]> {
    await this.#authorize(caller, "list");
    return (await this.#store.read()).open();
  }

  /** Approves a pending identity link, or confirms a pending Workshop user adoption. */
  async approve(caller: Caller, requestId: unknown): Promise<IdentityRequestOutcome> {
    const id = this.#parseId(requestId);
    await this.#authorize(caller, "approve", id);
    const request = requireOpen(await this.#store.read(), id);
    const actorId = caller.principal.principalId;
    return request.kind === "identity-link"
      ? this.#approveLink(request, actorId)
      : this.#confirmAdoption(request, actorId);
  }

  /** Rejects a pending identity link or Workshop user adoption. The directory is unchanged. */
  async reject(caller: Caller, requestId: unknown): Promise<IdentityRequestOutcome> {
    const id = this.#parseId(requestId);
    await this.#authorize(caller, "approve", id);
    const request = requireOpen(await this.#store.read(), id);
    if (request.status !== "pending") throw new SchoolOsError("conflict", "This identity link is already being approved.");
    const actorId = caller.principal.principalId;
    const at = this.#now().toISOString();

    if (request.kind === "identity-link") {
      const { snapshot } = await this.#directory.load();
      const directory = this.#sameDistrict(snapshot);
      // Only an interrupted approval can have written the link; finish that instead of contradicting it.
      if (alreadyLinked(directory, request.link)) throw new SchoolOsError("conflict", "This identity is already linked to the principal; approve the request instead.");
      const event = rejectIdentityLink(directory, request.link, { actorId, decidedAt: at });
      return this.#store.transact((index) => {
        requirePending(index, id);
        return { append: [{ type: "link-decided", requestId: id, event }], result: { request: { ...request, status: "rejected" }, event } };
      });
    }
    const event = adoptionEvent(request, "workshop-user-adoption.rejected", actorId, at);
    return this.#store.transact((index) => {
      requirePending(index, id);
      return { append: [{ type: "adoption-decided", requestId: id, event }], result: { request: { ...request, status: "rejected" }, event } };
    });
  }

  async #approveLink(request: Extract<IdentityRequest, { kind: "identity-link" }>, actorId: PrincipalId): Promise<IdentityRequestOutcome> {
    const id = request.requestId;
    const at = this.#now().toISOString();
    // Claim the approval first, so no rejection can land between writing the directory and
    // recording the decision. An approval already `approving` is a retry, which may claim again.
    await this.#store.transact((index) => {
      requireOpen(index, id);
      return { append: [{ type: "link-approval-started", requestId: id, actorId, at }], result: undefined };
    });

    const { version, snapshot } = await this.#directory.load();
    const directory = this.#sameDistrict(snapshot);
    let event: IdentityLinkAuditEvent;
    if (alreadyLinked(directory, request.link)) {
      // An earlier attempt wrote the directory and was interrupted before recording the decision.
      event = IdentityLinkAuditEvent.parse({
        districtId: directory.district.id,
        actor: { principalId: actorId },
        action: "identity-link.approved",
        target: { principalId: request.link.principalId, identity: request.link.identity },
        at,
      });
    } else {
      let approved: ReturnType<typeof approveIdentityLink>;
      try {
        // Re-runs every check: the identity may have been linked to someone else while it waited.
        approved = approveIdentityLink(directory, request.link, { actorId, decidedAt: at });
      } catch (error) {
        // The request cannot be approved against this directory: release the claim so it can be
        // rejected. A failed commit below is different (the directory moved), and stays claimed
        // so that approving again retries it.
        if (error instanceof SchoolOsError) await this.#abandon(id, at);
        throw error;
      }
      await this.#directory.commit(approved.directory, version);
      event = approved.event;
    }

    return this.#store.transact((index) => {
      const current = requireOpen(index, id);
      if (current.status !== "approving") throw new SchoolOsError("conflict", "This identity link's approval was interrupted; approve it again.");
      return { append: [{ type: "link-decided", requestId: id, event }], result: { request: { ...request, status: "approved" }, event } };
    });
  }

  async #abandon(requestId: IdentityRequestId, at: string): Promise<void> {
    await this.#store.transact((index) => {
      // A concurrent approval may have finished or abandoned it already; then there is nothing to release.
      const still = index.request(requestId)?.status === "approving";
      return { append: still ? [{ type: "link-approval-abandoned", requestId, at }] : [], result: undefined };
    });
  }

  async #confirmAdoption(request: Extract<IdentityRequest, { kind: "workshop-user-adoption" }>, actorId: PrincipalId): Promise<IdentityRequestOutcome> {
    const id = request.requestId;
    const { adoption } = request;
    const { snapshot } = await this.#directory.load();
    const principal = this.#sameDistrict(snapshot).principals.find((p) => p.id === adoption.principalId);
    if (principal === undefined) throw new SchoolOsError("not-found", "The principal this adoption names is no longer in the directory.");
    if (principal.kind === "service") throw new SchoolOsError("validation-failed", "A Workshop user cannot be adopted into a service principal.");

    const at = this.#now().toISOString();
    const event = adoptionEvent(request, "workshop-user-adoption.confirmed", actorId, at);
    const rebindIntent: WorkshopUserRebindIntent = {
      districtId: adoption.districtId,
      workshopUserId: adoption.workshopUserId,
      principalId: adoption.principalId,
      confirmedBy: actorId,
      confirmedAt: at,
    };
    return this.#store.transact((index) => {
      requirePending(index, id);
      if (index.adoptedInto(adoption.workshopUserId) !== undefined) throw new SchoolOsError("conflict", "This Workshop user has already been adopted.");
      if (index.hasAdopted(adoption.principalId)) throw new SchoolOsError("conflict", "This principal has already adopted a Workshop user.");
      return {
        append: [{ type: "adoption-decided", requestId: id, event, rebindIntent }],
        result: { request: { ...request, status: "approved" }, event, rebindIntent },
      };
    });
  }

  async #authorize(caller: Caller, action: Extract<Action, "list" | "approve">, requestId?: IdentityRequestId): Promise<void> {
    const { decision } = await this.#policy.decide({
      subject: caller.principal,
      action,
      resource: {
        kind: "identity-link",
        ...(requestId === undefined ? {} : { id: requestId }),
        scope: { level: "district", districtId: this.#store.districtId },
        classification: "restricted",
      },
      context: { channel: caller.channel },
    });
    if (decision.effect !== "allow") throw new SchoolOsError("forbidden", NOT_ALLOWED);
  }

  #parseId(requestId: unknown): IdentityRequestId {
    const parsed = IdentityRequestId.safeParse(requestId);
    if (!parsed.success) throw new SchoolOsError("validation-failed", "Expected an identity request ID.");
    return parsed.data;
  }

  #sameDistrict(snapshot: DistrictDirectorySnapshot): DistrictDirectorySnapshot {
    // Wiring a store of one district to another's directory is a deployment error, not a request's.
    if (snapshot.district.id !== this.#store.districtId) throw new Error("the identity-link store and the directory are of different districts");
    return snapshot;
  }
}

function requireOpen(index: IdentityLinkIndex, requestId: IdentityRequestId): IdentityRequest {
  const request = index.request(requestId);
  if (request === undefined) throw new SchoolOsError("not-found", "No such identity request in this district.");
  if (request.status === "approved" || request.status === "rejected") throw new SchoolOsError("conflict", "This identity request has already been decided.");
  return request;
}

function requirePending(index: IdentityLinkIndex, requestId: IdentityRequestId): void {
  if (requireOpen(index, requestId).status !== "pending") throw new SchoolOsError("conflict", "This identity link is already being approved.");
}

function alreadyLinked(directory: DistrictDirectorySnapshot, link: PendingIdentityLink): boolean {
  const key = externalIdentityKey(link.identity);
  return directory.principals.some((p) => p.id === link.principalId && p.externalIdentities.some((i) => externalIdentityKey(i) === key));
}

function adoptionEvent(
  request: Extract<IdentityRequest, { kind: "workshop-user-adoption" }>,
  action: WorkshopUserAdoptionAuditEvent["action"],
  actorId: PrincipalId,
  at: string,
): WorkshopUserAdoptionAuditEvent {
  return {
    districtId: request.adoption.districtId,
    actor: { principalId: actorId },
    action,
    target: { principalId: request.adoption.principalId, workshopUserId: request.adoption.workshopUserId },
    at,
  };
}
