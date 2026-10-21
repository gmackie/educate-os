import { type ActivityId, SchoolOsError } from "@schoolos/contracts";
import type { ActivityDefinitionId } from "./ids.ts";
import type { ActivityDefinition, ActivityInstallation } from "./model.ts";

/**
 * Where one district's curriculum service keeps its state: district-local D1 in production.
 * Published definition versions and installations are never rewritten.
 */
export interface CurriculumStorage {
  /** Every version of a definition, oldest first; empty if there is none. */
  listVersions(id: ActivityDefinitionId): Promise<ActivityDefinition[]>;
  /**
   * Stores a definition version: a new version, or a replacement for a draft one.
   *
   * @throws SchoolOsError `conflict` if that version is already published, or if it is new but
   *   not the next version.
   */
  putVersion(definition: ActivityDefinition): Promise<void>;
  /**
   * Adds an installation.
   *
   * @throws SchoolOsError `conflict` if its ID is already taken.
   */
  addInstallation(installation: ActivityInstallation): Promise<void>;
  getInstallation(id: ActivityId): Promise<ActivityInstallation | undefined>;
}

/** {@link CurriculumStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryCurriculumStorage implements CurriculumStorage {
  readonly #definitions = new Map<string, ActivityDefinition[]>();
  readonly #installations = new Map<string, ActivityInstallation>();

  async listVersions(id: ActivityDefinitionId): Promise<ActivityDefinition[]> {
    return (this.#definitions.get(id) ?? []).map((version) => structuredClone(version));
  }

  async putVersion(definition: ActivityDefinition): Promise<void> {
    const versions = this.#definitions.get(definition.id) ?? [];
    const existing = versions[definition.version - 1];
    if (existing?.status === "published") throw new SchoolOsError("conflict", `${definition.id} version ${definition.version} is published`);
    if (existing === undefined && definition.version !== versions.length + 1) {
      throw new SchoolOsError("conflict", `${definition.id} has no version ${definition.version - 1}`);
    }
    versions[definition.version - 1] = structuredClone(definition);
    this.#definitions.set(definition.id, versions);
  }

  async addInstallation(installation: ActivityInstallation): Promise<void> {
    if (this.#installations.has(installation.id)) throw new SchoolOsError("conflict", `${installation.id} already exists`);
    this.#installations.set(installation.id, structuredClone(installation));
  }

  async getInstallation(id: ActivityId): Promise<ActivityInstallation | undefined> {
    const installation = this.#installations.get(id);
    return installation === undefined ? undefined : structuredClone(installation);
  }
}
