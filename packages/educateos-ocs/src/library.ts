import { EducateOsError } from "@educateos/contracts";
import { type ActivityExportSource, type PublishedActivityExport, readActivityExport } from "./activity-export.ts";
import { type OcsFiles, readPackage } from "./package.ts";
import type { PackageSource, PublishedPackage } from "./resolver.ts";
import type { OcsPackageId } from "./schema.ts";

/**
 * An in-memory {@link PackageSource} and {@link ActivityExportSource} that also accepts
 * publications: the reference behavior for the district course library, and what tests use. A
 * published version, of a package or an export, is immutable: publishing the same version again
 * succeeds only with identical content.
 */
export class InMemoryPackageLibrary implements PackageSource, ActivityExportSource {
  readonly #packages = new Map<OcsPackageId, Map<string, PublishedPackage>>();
  readonly #exports = new Map<string, Map<string, PublishedActivityExport>>();

  /**
   * Adds a package version after reading and checking it.
   *
   * @throws OcsError `invalid-package` for invalid files, and EducateOsError `conflict` if the
   *   version was already published with different content.
   */
  async publish(files: OcsFiles): Promise<PublishedPackage> {
    const pkg = await readPackage(files);
    const versions = this.#packages.get(pkg.manifest.id) ?? new Map<string, PublishedPackage>();
    const existing = versions.get(pkg.manifest.version);
    if (existing !== undefined) {
      if (existing.digest === pkg.digest) return existing;
      throw new EducateOsError("conflict", `${pkg.manifest.id} ${pkg.manifest.version} is already published with different content; publish a new version instead`);
    }
    const published = { files: { ...files }, digest: pkg.digest };
    versions.set(pkg.manifest.version, published);
    this.#packages.set(pkg.manifest.id, versions);
    return published;
  }

  async listVersions(id: OcsPackageId): Promise<readonly string[]> {
    return [...(this.#packages.get(id)?.keys() ?? [])];
  }

  async getPackage(id: OcsPackageId, version: string): Promise<PublishedPackage | undefined> {
    const found = this.#packages.get(id)?.get(version);
    return found === undefined ? undefined : { files: { ...found.files }, digest: found.digest };
  }

  /**
   * Adds an activity export version (OCS 1.1) after reading and checking it.
   *
   * @throws OcsError `invalid-export` for an invalid file, and EducateOsError `conflict` if the
   *   version was already published with different content.
   */
  async publishExport(text: string): Promise<PublishedActivityExport> {
    const { export: exported, digest } = await readActivityExport(text);
    const versions = this.#exports.get(exported.id) ?? new Map<string, PublishedActivityExport>();
    const existing = versions.get(exported.version);
    if (existing !== undefined) {
      if (existing.digest === digest) return { ...existing };
      throw new EducateOsError("conflict", `${exported.id} ${exported.version} is already published with different content; publish a new version instead`);
    }
    versions.set(exported.version, { text, digest });
    this.#exports.set(exported.id, versions);
    return { text, digest };
  }

  async listExportVersions(id: string): Promise<readonly string[]> {
    return [...(this.#exports.get(id)?.keys() ?? [])];
  }

  async getExport(id: string, version: string): Promise<PublishedActivityExport | undefined> {
    const found = this.#exports.get(id)?.get(version);
    return found === undefined ? undefined : { ...found };
  }
}
