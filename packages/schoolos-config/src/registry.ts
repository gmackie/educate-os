import { CapabilityId, CapabilityManifest } from "@schoolos/contracts";
import { z } from "zod";
import { compareVersions, parseVersion, satisfies } from "./semver.ts";

/**
 * A capability pack as the compiler sees it: its manifest plus the Zod schema its configuration is
 * authored in. The manifest's `configSchema` is always derived from `config`, so the API, the CLI
 * and the administrator forms validate against the same source.
 */
export interface CapabilityPack {
  /** The validated manifest. */
  manifest: CapabilityManifest;
  /** The pack's configuration schema. Every field has a default, so `{}` is a valid configuration. */
  config: z.ZodType<Record<string, unknown>>;
  /**
   * Whether the pack can run as `advisory`: switched on, but with no official effect (for example
   * Assessment CI checks that inform a teacher without recording a grade).
   */
  supportsAdvisory: boolean;
}

/** A pack before validation: the manifest without `configSchema`, which is derived from `config`. */
export interface PackDefinition {
  /** The manifest fields, as data. */
  manifest: Omit<z.input<typeof CapabilityManifest>, "configSchema">;
  /** The pack's configuration schema. */
  config: z.ZodType<Record<string, unknown>>;
  /** See {@link CapabilityPack.supportsAdvisory}. */
  supportsAdvisory: boolean;
}

/** The JSON Schema for a pack configuration, as forms, the API and the CLI consume it. */
export function configJsonSchema(config: z.ZodType): Record<string, unknown> {
  // `input`: a field with a default is optional to whoever fills the form in.
  return z.toJSONSchema(config, { io: "input" }) as Record<string, unknown>;
}

/**
 * A validated set of capability packs. A pack may ship several versions; a configuration selects
 * one with a version range and its revision pins the version selected.
 */
export interface CapabilityRegistry {
  /**
   * The default version of every pack, keyed by ID: its newest release, or its newest prerelease
   * when it has no release.
   */
  readonly packs: ReadonlyMap<CapabilityId, CapabilityPack>;
  /** Every version of every pack, keyed by ID, oldest first. */
  readonly versions: ReadonlyMap<CapabilityId, readonly CapabilityPack[]>;
}

/** Why a set of pack definitions could not form a registry. */
export type RegistryProblem =
  | { kind: "invalid-manifest"; index: number; issues: string[] }
  | { kind: "duplicate-capability"; capabilityId: CapabilityId; version: string };

/** A registry, or every reason the definitions were rejected. */
export type RegistryResult =
  | { ok: true; registry: CapabilityRegistry }
  | { ok: false; problems: RegistryProblem[] };

function byVersion(a: CapabilityPack, b: CapabilityPack): number {
  return compareVersions(parseVersion(a.manifest.version)!, parseVersion(b.manifest.version)!);
}

/**
 * Validates every definition's manifest and builds a registry, reporting all problems at once.
 * Definitions may repeat a pack ID with different versions; repeating an ID and version is an error.
 */
export function createCapabilityRegistry(definitions: readonly PackDefinition[]): RegistryResult {
  const problems: RegistryProblem[] = [];
  const versions = new Map<CapabilityId, CapabilityPack[]>();
  definitions.forEach((definition, index) => {
    const parsed = CapabilityManifest.safeParse({
      ...definition.manifest,
      configSchema: configJsonSchema(definition.config),
    });
    const manifestIssues = parsed.success && parseVersion(parsed.data.version) === undefined
      ? [`version: ${parsed.data.version} is not a semantic version`]
      : [];
    if (!parsed.success || manifestIssues.length > 0) {
      problems.push({
        kind: "invalid-manifest",
        index,
        issues: parsed.success ? manifestIssues : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return;
    }
    const manifest = parsed.data;
    const existing = versions.get(manifest.id) ?? [];
    if (existing.some((pack) => pack.manifest.version === manifest.version)) {
      problems.push({ kind: "duplicate-capability", capabilityId: manifest.id, version: manifest.version });
      return;
    }
    versions.set(manifest.id, [...existing, { manifest, config: definition.config, supportsAdvisory: definition.supportsAdvisory }]);
  });
  if (problems.length > 0) return { ok: false, problems };
  const sorted = new Map([...versions].map(([id, list]) => [id, list.toSorted(byVersion)] as const));
  const packs = new Map([...sorted].map(([id, list]) => [
    id,
    list.findLast((pack) => parseVersion(pack.manifest.version)!.prerelease.length === 0) ?? list.at(-1)!,
  ] as const));
  return { ok: true, registry: { packs, versions: sorted } };
}

/** The pack at exactly `version`, if the registry still offers it. */
export function packVersion(registry: CapabilityRegistry, id: CapabilityId, version: string): CapabilityPack | undefined {
  return registry.versions.get(id)?.find((pack) => pack.manifest.version === version);
}

/** A reason a set of capabilities cannot be installed together. */
export type ResolutionProblem =
  | { kind: "unknown-capability"; capabilityId: CapabilityId }
  /** No version of a requested pack satisfies the range the configuration asked for. */
  | { kind: "no-version-in-range"; capabilityId: CapabilityId; versionRange: string; availableVersions: string[] }
  | { kind: "missing-dependency"; capabilityId: CapabilityId; dependencyId: CapabilityId; versionRange: string }
  | {
    kind: "version-mismatch";
    capabilityId: CapabilityId;
    dependencyId: CapabilityId;
    versionRange: string;
    /** The version of the dependency that was selected, which the range does not admit. */
    availableVersion: string;
  }
  | { kind: "invalid-version-range"; capabilityId: CapabilityId; dependencyId: CapabilityId; versionRange: string }
  | { kind: "conflict"; capabilityId: CapabilityId; conflictsWith: CapabilityId }
  /** A dependency cycle, starting and ending at its alphabetically first member. */
  | { kind: "dependency-cycle"; path: CapabilityId[] };

/** The outcome of resolving a requested set of capabilities. */
export interface DependencyResolution {
  /** The requested capabilities and everything they depend on, transitively, sorted by ID. */
  closure: CapabilityId[];
  /**
   * The version selected for each pack in the closure: the newest that every range on it admits,
   * or, when none does, its default version (and a problem says why).
   */
  selected: ReadonlyMap<CapabilityId, CapabilityPack>;
  /** The closure ordered dependencies-first. Empty whenever there are problems. */
  installOrder: CapabilityId[];
  /** For each capability in the closure, the capabilities in the closure that directly depend on it. */
  dependents: ReadonlyMap<CapabilityId, readonly CapabilityId[]>;
  /** Every problem found, not only the first. */
  problems: ResolutionProblem[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The newest version of `id` that every range admits, ranges that do not parse aside. */
function newestSatisfying(registry: CapabilityRegistry, id: CapabilityId, ranges: readonly string[]): CapabilityPack | undefined {
  return registry.versions.get(id)?.findLast((pack) =>
    ranges.every((range) => satisfies(pack.manifest.version, range) !== false)
  );
}

/** The closure reached from `requested` when each pack is taken at `pick(id)`. */
function closureOf(
  registry: CapabilityRegistry,
  requested: readonly CapabilityId[],
  pick: (id: CapabilityId) => CapabilityPack,
): Map<CapabilityId, CapabilityPack> {
  const reached = new Map<CapabilityId, CapabilityPack>();
  const pending = [...requested];
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (reached.has(id) || !registry.versions.has(id)) continue;
    const pack = pick(id);
    reached.set(id, pack);
    pending.push(...pack.manifest.dependencies.map((d) => d.id));
  }
  return reached;
}

/**
 * Resolves `requested` against the registry: pulls in dependencies transitively, selects a version
 * of each pack, then checks every dependency's version range, every declared conflict (in either
 * direction) and every cycle. The install order is deterministic: among packs whose dependencies
 * are met, the lowest ID goes first.
 *
 * Each pack is taken at the newest version admitted by its range in `ranges` (when the
 * configuration gives one) and by the range of every dependent in the closure. Selection repeats
 * until it settles, since a dependent's selected version decides which ranges apply; it never
 * backtracks to an older dependent to make room, so a range nothing satisfies is reported rather
 * than searched around.
 */
export function resolveDependencies(
  registry: CapabilityRegistry,
  requested: readonly CapabilityId[],
  ranges: ReadonlyMap<CapabilityId, string> = new Map(),
): DependencyResolution {
  const problems: ResolutionProblem[] = [];
  const roots = [...new Set(requested)].toSorted(byId);
  for (const id of roots) {
    if (!registry.versions.has(id)) problems.push({ kind: "unknown-capability", capabilityId: id });
  }

  // Each round picks versions under the ranges the previous round's picks impose.
  let selected = new Map<CapabilityId, CapabilityPack>();
  const rounds = [...registry.versions.values()].reduce((sum, list) => sum + list.length, 1);
  for (let round = 0; round < rounds; round++) {
    const constraints = new Map<CapabilityId, string[]>();
    for (const [id, range] of ranges) constraints.set(id, [range]);
    for (const pack of selected.values()) {
      for (const { id, versionRange } of pack.manifest.dependencies) constraints.set(id, [...(constraints.get(id) ?? []), versionRange]);
    }
    const next = closureOf(registry, roots, (id) =>
      newestSatisfying(registry, id, constraints.get(id) ?? []) ?? registry.packs.get(id)!
    );
    const settled = next.size === selected.size
      && [...next].every(([id, pack]) => selected.get(id)?.manifest.version === pack.manifest.version);
    selected = next;
    if (settled) break;
  }

  for (const [id, range] of ranges) {
    const pack = selected.get(id);
    if (pack !== undefined && satisfies(pack.manifest.version, range) !== true) {
      problems.push({
        kind: "no-version-in-range",
        capabilityId: id,
        versionRange: range,
        availableVersions: registry.versions.get(id)!.map((p) => p.manifest.version),
      });
    }
  }

  const members = [...selected.keys()].toSorted(byId);
  for (const id of members) {
    for (const { id: dependencyId, versionRange } of selected.get(id)!.manifest.dependencies) {
      const dependency = selected.get(dependencyId);
      if (dependency === undefined) {
        problems.push({ kind: "missing-dependency", capabilityId: id, dependencyId, versionRange });
        continue;
      }
      const matches = satisfies(dependency.manifest.version, versionRange);
      if (matches === undefined) {
        problems.push({ kind: "invalid-version-range", capabilityId: id, dependencyId, versionRange });
      } else if (!matches) {
        problems.push({
          kind: "version-mismatch",
          capabilityId: id,
          dependencyId,
          versionRange,
          availableVersion: dependency.manifest.version,
        });
      }
    }
  }

  const edges = new Map<CapabilityId, CapabilityId[]>(members.map((id) => [
    id,
    selected.get(id)!.manifest.dependencies.map((d) => d.id).filter((d) => selected.has(d)).toSorted(byId),
  ]));
  const dependents = new Map<CapabilityId, CapabilityId[]>(members.map((id) => [id, []]));
  for (const id of members) for (const dependencyId of edges.get(id)!) dependents.get(dependencyId)!.push(id);

  const reportedConflicts = new Set<string>();
  for (const id of members) {
    for (const other of selected.get(id)!.manifest.conflicts ?? []) {
      if (!selected.has(other)) continue;
      const [first, second] = [id, other].toSorted(byId) as [CapabilityId, CapabilityId];
      if (reportedConflicts.has(`${first} ${second}`)) continue;
      reportedConflicts.add(`${first} ${second}`);
      problems.push({ kind: "conflict", capabilityId: first, conflictsWith: second });
    }
  }

  problems.push(...findCycles(members, edges));

  return {
    closure: members,
    selected,
    installOrder: problems.length > 0 ? [] : topologicalOrder(members, edges),
    dependents,
    problems,
  };
}

/**
 * The cycles closed by each back edge of a depth-first search, so every strongly connected group of
 * packs is reported. Each cycle appears once, rotated to start at its alphabetically first member.
 */
function findCycles(
  members: readonly CapabilityId[],
  edges: ReadonlyMap<CapabilityId, readonly CapabilityId[]>,
): ResolutionProblem[] {
  const found = new Map<string, CapabilityId[]>();
  const done = new Set<CapabilityId>();
  const stack: CapabilityId[] = [];
  const visit = (id: CapabilityId) => {
    const open = stack.indexOf(id);
    if (open >= 0) {
      const cycle = stack.slice(open);
      const start = cycle.indexOf(cycle.toSorted(byId)[0]!);
      const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
      found.set(rotated.join(" "), [...rotated, rotated[0]!]);
      return;
    }
    if (done.has(id)) return;
    stack.push(id);
    for (const next of edges.get(id)!) visit(next);
    stack.pop();
    done.add(id);
  };
  for (const id of members) visit(id);
  return [...found.keys()].toSorted(byId).map((key) => ({ kind: "dependency-cycle", path: found.get(key)! }));
}

function topologicalOrder(
  members: readonly CapabilityId[],
  edges: ReadonlyMap<CapabilityId, readonly CapabilityId[]>,
): CapabilityId[] {
  const order: CapabilityId[] = [];
  const placed = new Set<CapabilityId>();
  while (order.length < members.length) {
    const next = members.find((id) => !placed.has(id) && edges.get(id)!.every((d) => placed.has(d)))!;
    order.push(next);
    placed.add(next);
  }
  return order;
}
