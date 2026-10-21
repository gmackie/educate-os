import { PrincipalId, SchoolOsError, WorkspaceId } from "@schoolos/contracts";
import type { StorageHandle, Workspace } from "./model.ts";
import { attachStorageHandle, type WorkspaceStore } from "./store.ts";

/** What {@link WorkshopWorkspaceSeam.ensureExternalWorkspace} is asked to create or return. */
export interface WorkshopWorkspaceRequest {
  /** The SchoolOS workspace ID, which the Workshop keys the workspace by and never interprets. */
  externalId: WorkspaceId;
  /** The Workshop profile ID of the account the workspace belongs to. */
  owner: string;
  /** The workspace's kind, recorded by the Workshop with its own record of the workspace. */
  kind: Workspace["kind"];
  /** The title the Workshop workspace is created with. */
  title: string;
}

/**
 * The Workshop kernel's workspace seam (`AuthenticatedApi.ensureExternalWorkspace`), held as the
 * workspace owner's own session. The kernel refuses a request whose `owner` is not that session's
 * account, and returns the same reference for every call with the same `externalId`.
 */
export interface WorkshopWorkspaceSeam {
  /** Creates the owner's Workshop workspace for `request.externalId`, or returns the existing one's ID. */
  ensureExternalWorkspace(request: WorkshopWorkspaceRequest): Promise<string>;
}

/**
 * A workspace owner's Workshop session: the principal it acts as, its Workshop account, and the
 * seam reached through it. Principal resolution at sign-in (F04) is what establishes the three
 * belong together; this adapter only checks the principal is the workspace's owner.
 */
export interface WorkshopOwnerSession {
  /** The SchoolOS principal the session acts as. */
  principalId: PrincipalId;
  /** The session's Workshop profile ID. */
  profileId: string;
  /** The kernel seam, called as this session. */
  seam: WorkshopWorkspaceSeam;
}

/**
 * Gives workspace `workspaceId` its Workshop workspace, as its owner, and returns the storage
 * handle. A workspace already backed by storage is returned as it is, without calling the kernel;
 * otherwise the kernel's reference is attached with {@link attachStorageHandle}. Both steps are
 * idempotent, so a call that failed part way can simply be repeated.
 *
 * Refuses `forbidden` when `owner` is anyone but the workspace's owner. The Workshop workspace
 * is never shared and never made ambient, and nothing is deleted.
 */
export async function provisionWorkshopWorkspace(
  store: WorkspaceStore,
  workspaceId: WorkspaceId,
  owner: WorkshopOwnerSession,
  title: string,
): Promise<StorageHandle> {
  const id = WorkspaceId.parse(workspaceId);
  const workspace = (await store.load()).state.workspaces.find((w) => w.id === id);
  if (workspace === undefined) throw new SchoolOsError("not-found", `Workspace ${id} was not found.`);
  if (PrincipalId.parse(owner.principalId) !== workspace.ownerPrincipalId) {
    throw new SchoolOsError("forbidden", "Only a workspace's owner can create its storage.");
  }
  if (workspace.storageHandle !== undefined) return workspace.storageHandle;

  const ref = await owner.seam.ensureExternalWorkspace({ externalId: id, owner: owner.profileId, kind: workspace.kind, title });
  const handle: StorageHandle = { backend: "workshop", ref };
  await attachStorageHandle(store, id, handle);
  return handle;
}
