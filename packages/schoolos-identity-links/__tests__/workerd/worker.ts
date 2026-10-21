// Test worker for the workerd suite: Northfield's district control Durable Object, hosting the
// identity-link log over `DurableObjectIdentityLinkStore` and the admin service over it, the way a
// deployed district Worker would, so concurrent decisions arrive as separate requests to one object.
// The directory is held in memory and reseeded per instance; only the log is under test.

import { DurableObject } from "cloudflare:workers";
import { SchoolOsError, type PrincipalId } from "@schoolos/contracts";
import {
  recordPendingAdoptions,
  recordPendingIdentityLink,
  type IdentityControlAuditEvent,
  type IdentityLinkEntry,
  type IdentityRequest,
  type IdentityRequestId,
  type WorkshopUserRebindIntent,
} from "../../src/index.ts";
import { DurableObjectIdentityLinkStore } from "../../src/durable-object-store.ts";
import { AT, caller, NF, northfieldControl } from "../support.ts";

/** A call's outcome, with a refusal's code carried across RPC rather than its error. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof SchoolOsError) return { ok: false, code: error.code };
    throw error;
  }
}

/** Northfield's identity-link control. */
export class TestIdentityControl extends DurableObject {
  readonly #control: ReturnType<typeof northfieldControl>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#control = northfieldControl(new DurableObjectIdentityLinkStore(ctx.storage, NF));
  }

  /** Records a pending link. */
  async recordLink(link: unknown): Promise<Result<IdentityRequestId>> {
    return attempt(() => recordPendingIdentityLink(this.#control.store, link));
  }

  /** Records a plan's pending adoptions. */
  async proposeAdoptions(plan: unknown): Promise<Result<IdentityRequestId[]>> {
    return attempt(() => recordPendingAdoptions(this.#control.store, plan, AT));
  }

  /** Lists open requests as `principalId`. */
  async listPending(principalId: PrincipalId): Promise<Result<IdentityRequest[]>> {
    return attempt(() => this.#control.service.listPending(caller(principalId)));
  }

  /** Approves as `principalId`. */
  async approve(principalId: PrincipalId, requestId: string): Promise<Result<string>> {
    return attempt(async () => (await this.#control.service.approve(caller(principalId), requestId)).event.action);
  }

  /** Rejects as `principalId`. */
  async reject(principalId: PrincipalId, requestId: string): Promise<Result<string>> {
    return attempt(async () => (await this.#control.service.reject(caller(principalId), requestId)).event.action);
  }

  /** Every committed entry. */
  async entries(): Promise<readonly IdentityLinkEntry[]> {
    return (await this.#control.store.read()).entries;
  }

  /** The persisted audit trail. */
  async auditEvents(): Promise<IdentityControlAuditEvent[]> {
    return (await this.#control.store.read()).auditEvents();
  }

  /** The persisted rebind intents. */
  async rebindIntents(): Promise<WorkshopUserRebindIntent[]> {
    return (await this.#control.store.read()).rebindIntents();
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
