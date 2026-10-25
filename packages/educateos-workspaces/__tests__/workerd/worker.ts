// Test worker for the workerd suite: a Durable Object that hosts one district's workspace directory
// over `DurableObjectWorkspaceStore`, the way a deployed directory Worker does, so concurrent first
// accesses arrive as separate requests to one object.

import { DurableObject } from "cloudflare:workers";
import type { OfferingId, WorkspaceId } from "@educateos/contracts";
import type { WorkspaceState, WorkspaceDirectory } from "../../src/index.ts";
import { DurableObjectWorkspaceStore } from "../../src/durable-object-store.ts";
import { as, setup } from "../setup.ts";

/** Northfield's workspace directory, kept in this object's SQLite storage. */
export class TestDirectory extends DurableObject {
  readonly #store: DurableObjectWorkspaceStore;
  readonly #directory: WorkspaceDirectory;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#store = new DurableObjectWorkspaceStore(ctx.storage);
    this.#directory = setup(undefined, { store: this.#store }).workspaces;
  }

  /** The principal's personal workspace, provisioned on first access. */
  async personal(principalId: string): Promise<WorkspaceId> {
    return (await this.#directory.ensurePersonalWorkspace(as(principalId))).id;
  }

  /** The principal's workspace for an offering, provisioned on first access. */
  async course(principalId: string, offeringId: OfferingId): Promise<WorkspaceId> {
    return (await this.#directory.ensureCourseWorkspace(as(principalId), offeringId)).id;
  }

  /** The stored state and its version. */
  async stored(): Promise<{ version: number; state: WorkspaceState }> {
    return this.#store.load();
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
