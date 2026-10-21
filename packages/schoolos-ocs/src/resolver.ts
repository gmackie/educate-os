import { OcsError, type VersionRequirement } from "./errors.ts";
import { formatJson, type OcsFiles, type OcsPackage, packageDigest, readPackage } from "./package.ts";
import { OCS_SPEC_VERSION, OcsLock, type OcsLockedPackage, type OcsManifest, type OcsPackageId, type Sha256Digest } from "./schema.ts";
import { compareVersions, satisfies, SemVer } from "./semver.ts";

/** One published package version as a source holds it. */
export interface PublishedPackage {
  files: OcsFiles;
  /** The digest recorded when the version was published. The resolver checks the files against it. */
  digest: Sha256Digest;
}

/**
 * Where published course packages come from: a district library, a publisher's catalog, or a
 * mirror. A source is not trusted to return what was asked for: the resolver checks every
 * package's ID, version and digest itself.
 */
export interface PackageSource {
  /** Every published version of a package, in any order; empty if the package is unknown. */
  listVersions(id: OcsPackageId): Promise<readonly string[]>;
  /** One published version, or undefined if there is none. */
  getPackage(id: OcsPackageId, version: SemVer): Promise<PublishedPackage | undefined>;
}

/** Options for {@link resolveCourse}. */
export interface ResolveOptions {
  /**
   * A previous lockfile. A package keeps its locked version while that version still satisfies
   * every requirement, so adding one module never silently updates the others, and its content
   * must still match the locked digest.
   */
  locked?: OcsLock | undefined;
}

/** A resolved course: its lockfile and every package it includes, read and verified. */
export interface Resolution {
  lock: OcsLock;
  root: OcsPackage;
  /** Every included package by ID, the course itself excluded. */
  packages: ReadonlyMap<OcsPackageId, OcsPackage>;
}

// Each round re-selects every package from the previous round's requirements. Ordinary graphs settle
// in as many rounds as they are deep; this bound only stops requirements that chase each other forever.
const MAX_ROUNDS = 64;

const lockedEntries = (lock: OcsLock | undefined) => new Map((lock?.packages ?? []).map((entry) => [entry.id, entry]));

/**
 * Resolves a course's modules into a lockfile (RFC 0001 §6). Every package resolves to exactly one
 * version: the locked version if it still fits, otherwise the highest available version that
 * satisfies every range that requires it. There is no backtracking: if no single version fits,
 * the conflict is reported rather than searched around. Every package fetched is checked against
 * its published digest, any digest the requiring module pins, and any locked digest. The same
 * root, source contents and lock always produce the same lockfile.
 *
 * @throws OcsError `unknown-package`, `version-conflict`, `cycle`, `digest-mismatch`,
 *   `identity-mismatch`, or `invalid-package` for a dependency whose files are invalid.
 */
export async function resolveCourse(root: OcsPackage, source: PackageSource, options: ResolveOptions = {}): Promise<Resolution> {
  const locked = lockedEntries(options.locked);
  const versionCache = new Map<OcsPackageId, SemVer[]>();
  const packageCache = new Map<string, OcsPackage>();

  const versionsOf = async (id: OcsPackageId): Promise<SemVer[]> => {
    let versions = versionCache.get(id);
    if (versions === undefined) {
      versions = [...new Set(await source.listVersions(id))].filter((v) => SemVer.safeParse(v).success).toSorted((a, b) => compareVersions(b, a));
      versionCache.set(id, versions);
    }
    return versions;
  };

  const load = async (id: OcsPackageId, version: SemVer): Promise<OcsPackage> => {
    const key = `${id}@${version}`;
    const cached = packageCache.get(key);
    if (cached !== undefined) return cached;
    const published = await source.getPackage(id, version);
    if (published === undefined) throw new OcsError({ kind: "unknown-package", packageId: id, version });
    const actual = await packageDigest(published.files);
    if (actual !== published.digest) throw new OcsError({ kind: "digest-mismatch", packageId: id, version, expected: published.digest, actual });
    const lockedEntry = locked.get(id);
    if (lockedEntry?.version === version && lockedEntry.digest !== actual) {
      throw new OcsError({ kind: "digest-mismatch", packageId: id, version, expected: lockedEntry.digest, actual });
    }
    const pkg = await readPackage(published.files);
    if (pkg.manifest.id !== id || pkg.manifest.version !== version) {
      throw new OcsError({ kind: "identity-mismatch", packageId: id, version, found: `${pkg.manifest.id}@${pkg.manifest.version}` });
    }
    packageCache.set(key, pkg);
    return pkg;
  };

  const rootId = root.manifest.id;
  let selected = new Map<OcsPackageId, SemVer>();
  for (let round = 0; ; round++) {
    // Collect what the course and every package selected so far require.
    const requirements = new Map<OcsPackageId, (VersionRequirement & { digest?: Sha256Digest })[]>();
    const queue: { label: string; manifest: OcsManifest }[] = [{ label: rootId, manifest: root.manifest }];
    const visited = new Set<string>([rootId]);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      for (const module of next.manifest.modules) {
        // A module that includes the course itself is a cycle, reported with its full path below.
        if (module.package === rootId) continue;
        const list = requirements.get(module.package) ?? [];
        list.push({ requiredBy: next.label, range: module.range, ...(module.digest === undefined ? {} : { digest: module.digest }) });
        requirements.set(module.package, list);
        const version = selected.get(module.package);
        if (version !== undefined && !visited.has(module.package)) {
          visited.add(module.package);
          queue.push({ label: `${module.package}@${version}`, manifest: (await load(module.package, version)).manifest });
        }
      }
    }

    // Select one version of each required package, in ID order.
    const chosen = new Map<OcsPackageId, SemVer>();
    for (const id of [...requirements.keys()].toSorted()) {
      const needs = requirements.get(id)!.toSorted((a, b) => (a.requiredBy < b.requiredBy ? -1 : a.requiredBy > b.requiredBy ? 1 : 0));
      const available = await versionsOf(id);
      if (available.length === 0) throw new OcsError({ kind: "unknown-package", packageId: id });
      const fitting = available.filter((version) => needs.every((need) => satisfies(version, need.range)));
      const lockedVersion = locked.get(id)?.version;
      const version = lockedVersion !== undefined && fitting.includes(lockedVersion) ? lockedVersion : fitting[0];
      if (version === undefined) {
        throw new OcsError({
          kind: "version-conflict",
          packageId: id,
          requirements: needs.map(({ requiredBy, range }) => ({ requiredBy, range })),
          available: available.toReversed(),
        });
      }
      const pkg = await load(id, version);
      for (const need of needs) {
        if (need.digest !== undefined && need.digest !== pkg.digest) {
          throw new OcsError({ kind: "digest-mismatch", packageId: id, version, expected: need.digest, actual: pkg.digest });
        }
      }
      chosen.set(id, version);
    }

    const changed = [...chosen.keys()].filter((id) => selected.get(id) !== chosen.get(id));
    const settled = changed.length === 0 && chosen.size === selected.size;
    selected = chosen;
    if (settled) break;
    if (round === MAX_ROUNDS) {
      // The requirements never settle: each choice changes what the others require.
      const id = changed[0] ?? [...chosen.keys()][0] ?? rootId;
      const requirementsOf = (requirements.get(id) ?? []).map(({ requiredBy, range }) => ({ requiredBy, range }));
      throw new OcsError({ kind: "version-conflict", packageId: id, requirements: requirementsOf, available: (await versionsOf(id)).toReversed() });
    }
  }

  const packages = new Map<OcsPackageId, OcsPackage>();
  for (const [id, version] of selected) packages.set(id, await load(id, version));
  rejectCycles(rootId, root, packages);

  const entryOf = (pkg: OcsPackage): OcsLockedPackage => ({
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    digest: pkg.digest,
    modules: pkg.manifest.modules
      .map((module) => ({ name: module.name, package: module.package, version: selected.get(module.package)! }))
      .toSorted((a, b) => (a.name < b.name ? -1 : 1)),
  });
  const lock = OcsLock.parse({
    lockVersion: 1,
    specVersion: OCS_SPEC_VERSION,
    root: entryOf(root),
    packages: [...packages.keys()].toSorted().map((id) => entryOf(packages.get(id)!)),
  } satisfies OcsLock);
  return { lock, root, packages };
}

/** Rejects a module graph in which a package includes itself, directly or through others. */
function rejectCycles(rootId: OcsPackageId, root: OcsPackage, packages: ReadonlyMap<OcsPackageId, OcsPackage>): void {
  const done = new Set<string>();
  const visit = (id: OcsPackageId, pkg: OcsPackage, path: OcsPackageId[]): void => {
    if (done.has(id)) return;
    for (const module of pkg.manifest.modules.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const at = path.indexOf(module.package);
      if (at !== -1) throw new OcsError({ kind: "cycle", path: [...path.slice(at), module.package] });
      visit(module.package, packages.get(module.package)!, [...path, module.package]);
    }
    done.add(id);
  };
  visit(rootId, root, [rootId]);
}

/** A lockfile's bytes: canonical, indented JSON. Equal lockfiles always serialize identically. */
export function serializeLock(lock: OcsLock): string {
  return formatJson(OcsLock.parse(lock));
}
