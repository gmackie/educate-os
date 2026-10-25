import { EducateOsError, type ContentItemId, type ResourceId } from "@educateos/contracts";
import type { ClassBinding, ContentItem, StudioRelease } from "./item.ts";
import type { StudioAuditEvent } from "./pipeline.ts";

/**
 * Where one district's studio keeps its state: district-local D1, R2 and a Durable Object in
 * production. Releases, snapshots and audit events are append-only.
 */
export interface ContentStudioStorage {
  getItem(id: ContentItemId): Promise<ContentItem | undefined>;
  listItems(): Promise<ContentItem[]>;
  /**
   * Stores `item` if the stored revision is `item.revision - 1` (absent when it is 1).
   *
   * @throws EducateOsError `conflict` otherwise.
   */
  putItem(item: ContentItem): Promise<void>;
  /** Keeps raw bytes in quarantine under their digest. Storing the same digest again is a no-op. */
  putSnapshot(digest: string, bytes: Uint8Array): Promise<void>;
  getSnapshot(digest: string): Promise<Uint8Array | undefined>;
  /**
   * Adds a release.
   *
   * @throws EducateOsError `conflict` if the resource already has a release with that version.
   */
  addRelease(release: StudioRelease): Promise<void>;
  /** Every release, or every release of one resource, oldest first. */
  listReleases(resourceId?: ResourceId): Promise<StudioRelease[]>;
  addBinding(binding: ClassBinding): Promise<void>;
  listBindings(): Promise<ClassBinding[]>;
  appendAudit(event: StudioAuditEvent): Promise<void>;
  listAudit(itemId: ContentItemId): Promise<StudioAuditEvent[]>;
}

/** {@link ContentStudioStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryContentStudioStorage implements ContentStudioStorage {
  readonly #items = new Map<string, ContentItem>();
  readonly #snapshots = new Map<string, Uint8Array>();
  readonly #releases: StudioRelease[] = [];
  readonly #bindings: ClassBinding[] = [];
  readonly #audit: StudioAuditEvent[] = [];

  async getItem(id: ContentItemId): Promise<ContentItem | undefined> {
    const item = this.#items.get(id);
    return item === undefined ? undefined : structuredClone(item);
  }

  async listItems(): Promise<ContentItem[]> {
    return [...this.#items.values()].map((item) => structuredClone(item));
  }

  async putItem(item: ContentItem): Promise<void> {
    if ((this.#items.get(item.id)?.revision ?? 0) !== item.revision - 1) {
      throw new EducateOsError("conflict", `${item.id} changed since it was read`);
    }
    this.#items.set(item.id, structuredClone(item));
  }

  async putSnapshot(digest: string, bytes: Uint8Array): Promise<void> {
    if (!this.#snapshots.has(digest)) this.#snapshots.set(digest, bytes.slice());
  }

  async getSnapshot(digest: string): Promise<Uint8Array | undefined> {
    return this.#snapshots.get(digest)?.slice();
  }

  async addRelease(release: StudioRelease): Promise<void> {
    const { id, release: { version } } = release.descriptor;
    if (this.#releases.some((r) => r.descriptor.id === id && r.descriptor.release.version === version)) {
      throw new EducateOsError("conflict", `${id} already has release ${version}`);
    }
    this.#releases.push(structuredClone(release));
  }

  async listReleases(resourceId?: ResourceId): Promise<StudioRelease[]> {
    return this.#releases.filter((r) => resourceId === undefined || r.descriptor.id === resourceId).map((r) => structuredClone(r));
  }

  async addBinding(binding: ClassBinding): Promise<void> {
    this.#bindings.push(structuredClone(binding));
  }

  async listBindings(): Promise<ClassBinding[]> {
    return this.#bindings.map((b) => structuredClone(b));
  }

  async appendAudit(event: StudioAuditEvent): Promise<void> {
    this.#audit.push(structuredClone(event));
  }

  async listAudit(itemId: ContentItemId): Promise<StudioAuditEvent[]> {
    return this.#audit.filter((e) => e.itemId === itemId).map((e) => structuredClone(e));
  }
}
