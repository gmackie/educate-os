import { SchoolOsError } from "@schoolos/contracts";
import { type OcsFiles, readPackage } from "./package.ts";
import type { PackageSource, PublishedPackage } from "./resolver.ts";
import type { OcsPackageId } from "./schema.ts";

/**
 * An in-memory {@link PackageSource} that also accepts publications: the reference behavior for
 * the district course library, and what tests use. A published version is immutable: publishing
 * the same version again succeeds only with identical content.
 */
export class InMemoryPackageLibrary implements PackageSource {
  readonly #packages = new Map<OcsPackageId, Map<string, PublishedPackage>>();

  /**
   * Adds a package version after reading and checking it.
   *
   * @throws OcsError `invalid-package` for invalid files, and SchoolOsError `conflict` if the
   *   version was already published with different content.
   */
  async publish(files: OcsFiles): Promise<PublishedPackage> {
    const pkg = await readPackage(files);
    const versions = this.#packages.get(pkg.manifest.id) ?? new Map<string, PublishedPackage>();
    const existing = versions.get(pkg.manifest.version);
    if (existing !== undefined) {
      if (existing.digest === pkg.digest) return existing;
      throw new SchoolOsError("conflict", `${pkg.manifest.id} ${pkg.manifest.version} is already published with different content; publish a new version instead`);
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
}
