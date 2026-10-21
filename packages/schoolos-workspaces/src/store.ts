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
 * Where one district's workspace directory is kept. A write replaces the state as a whole, and
 * only if nothing else committed since it was loaded, so two concurrent first accesses cannot
 * provision two workspaces for the same key.
 */
export interface WorkspaceStore {
  /** Reads the current state. */
  load(): Promise<StoredWorkspaces>;
  /** Stores `next` if the stored version is still `expectedVersion`, and throws `conflict` if not. */
  commit(next: WorkspaceState, expectedVersion: number): Promise<void>;
}

/** A {@link WorkspaceStore} held in memory, for tests and the local harness. */
export class InMemoryWorkspaceStore implements WorkspaceStore {
  #state: WorkspaceState = { workspaces: [], grants: [], closures: [], promotions: [], events: [] };
  #version = 0;

  async load(): Promise<StoredWorkspaces> {
    return { version: this.#version, state: structuredClone(this.#state) };
  }

  async commit(next: WorkspaceState, expectedVersion: number): Promise<void> {
    if (expectedVersion !== this.#version) {
      throw new SchoolOsError("conflict", "The workspace directory changed while this request was in progress; retry it.");
    }
    this.#state = structuredClone(WorkspaceState.parse(next));
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
