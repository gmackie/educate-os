import { SchoolOsError } from "@schoolos/contracts";
import { WorkspaceState } from "./model.ts";

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
