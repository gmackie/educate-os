import { SchoolOsError, WorkspaceId } from "@schoolos/contracts";
import { StorageHandle, WorkspaceState, type Workspace } from "./model.ts";

/** The workspace state as stored, with the version optimistic concurrency checks against. */
export interface StoredWorkspaces {
  /** Increases by one on every commit. */
  version: number;
  /** The state. Callers own this copy and may not assume edits to it are stored. */
  state: WorkspaceState;
}

/**
 * Where one district's workspace directory is kept. A write replaces the state as a whole, only if
 * nothing else committed since it was loaded, and only if it keeps the invariants
 * {@link assertWorkspaceInvariants} checks, so two concurrent first accesses cannot provision two
 * workspaces for the same key.
 */
export interface WorkspaceStore {
  /** Reads the current state. */
  load(): Promise<StoredWorkspaces>;
  /** Stores `next` if the stored version is still `expectedVersion`, and throws `conflict` if not. */
  commit(next: WorkspaceState, expectedVersion: number): Promise<void>;
}

/** A district's workspace state before anything is stored. */
export function emptyWorkspaceState(): WorkspaceState {
  return { workspaces: [], grants: [], closures: [], promotions: [], events: [], deletions: [] };
}

/**
 * Refuses a state that breaks a workspace key. Every store implementation calls it before writing:
 * workspace IDs are unique, a principal has at most one personal workspace (the personal key), and
 * at most one course workspace per offering (the course key, principal and offering).
 */
export function assertWorkspaceInvariants(state: WorkspaceState): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const workspace of state.workspaces) {
    const key = workspaceKey(workspace);
    if (ids.has(workspace.id) || keys.has(key)) {
      throw new SchoolOsError("policy-violation", `Workspace ${workspace.id} duplicates an existing workspace.`);
    }
    ids.add(workspace.id);
    keys.add(key);
  }
}

/** The key a workspace is unique by: its owner, and for a course workspace its offering. */
function workspaceKey(workspace: WorkspaceState["workspaces"][number]): string {
  return workspace.kind === "personal" ? `personal ${workspace.ownerPrincipalId}` : `course ${workspace.ownerPrincipalId} ${workspace.offeringId}`;
}

/** A {@link WorkspaceStore} held in memory, for tests and the local harness. */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  #state: WorkspaceState = emptyWorkspaceState();
  #version = 0;

  async load(): Promise<StoredWorkspaces> {
    return { version: this.#version, state: structuredClone(this.#state) };
  }

  async commit(next: WorkspaceState, expectedVersion: number): Promise<void> {
    if (expectedVersion !== this.#version) {
      throw new SchoolOsError("conflict", "The workspace directory changed while this request was in progress; retry it.");
    }
    const parsed = WorkspaceState.parse(next);
    assertWorkspaceInvariants(parsed);
    this.#state = structuredClone(parsed);
    this.#version += 1;
  }
}

/** Commit attempts before {@link attachStorageHandle} gives up on concurrent changes and reports the conflict. */
const ATTACH_ATTEMPTS = 3;

/**
 * Records `handle` as the storage backing workspace `workspaceId`, and returns the workspace.
 *
 * A workspace's storage is attached once and never replaced: attaching the handle it already has
 * changes nothing, so a retry is safe, and attaching a different one throws `conflict`. This is a
 * store operation for the service that created the storage as the workspace's owner, and decides
 * no access itself; the directory shows a handle only to the workspace's owner.
 */
export async function attachStorageHandle(
  store: WorkspaceStore,
  workspaceId: WorkspaceId,
  handle: StorageHandle,
): Promise<Workspace> {
  const id = WorkspaceId.parse(workspaceId);
  const attached = StorageHandle.parse(handle);
  for (let attempt = 1; ; attempt++) {
    const { state, version } = await store.load();
    const workspace = state.workspaces.find((w) => w.id === id);
    if (workspace === undefined) throw new SchoolOsError("not-found", `Workspace ${id} was not found.`);
    if (workspace.storageHandle !== undefined) {
      if (workspace.storageHandle.backend === attached.backend && workspace.storageHandle.ref === attached.ref) return workspace;
      throw new SchoolOsError("conflict", `Workspace ${id} is already backed by other storage.`);
    }
    workspace.storageHandle = attached;
    try {
      await store.commit(state, version);
      return workspace;
    } catch (error) {
      if (!(error instanceof SchoolOsError && error.code === "conflict") || attempt >= ATTACH_ATTEMPTS) throw error;
    }
  }
}
