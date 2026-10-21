import { CapabilityId, CapabilityManifest } from "@schoolos/contracts";
import { z } from "zod";
import { satisfies } from "./semver.ts";

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

/** A validated, de-duplicated set of capability packs, keyed by ID. */
export interface CapabilityRegistry {
  /** Every pack, keyed by its ID. */
  readonly packs: ReadonlyMap<CapabilityId, CapabilityPack>;
}

/** Why a set of pack definitions could not form a registry. */
export type RegistryProblem =
  | { kind: "invalid-manifest"; index: number; issues: string[] }
  | { kind: "duplicate-capability"; capabilityId: CapabilityId };

/** A registry, or every reason the definitions were rejected. */
export type RegistryResult =
  | { ok: true; registry: CapabilityRegistry }
  | { ok: false; problems: RegistryProblem[] };

/** Validates every definition's manifest and builds a registry, reporting all problems at once. */
export function createCapabilityRegistry(definitions: readonly PackDefinition[]): RegistryResult {
  const problems: RegistryProblem[] = [];
  const packs = new Map<CapabilityId, CapabilityPack>();
  definitions.forEach((definition, index) => {
    const parsed = CapabilityManifest.safeParse({
      ...definition.manifest,
      configSchema: configJsonSchema(definition.config),
    });
    if (!parsed.success) {
      problems.push({
        kind: "invalid-manifest",
        index,
        issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
      return;
    }
    const manifest = parsed.data;
    if (packs.has(manifest.id)) {
      problems.push({ kind: "duplicate-capability", capabilityId: manifest.id });
      return;
    }
    packs.set(manifest.id, { manifest, config: definition.config, supportsAdvisory: definition.supportsAdvisory });
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, registry: { packs } };
}

/** A reason a set of capabilities cannot be installed together. */
export type ResolutionProblem =
  | { kind: "unknown-capability"; capabilityId: CapabilityId }
  | { kind: "missing-dependency"; capabilityId: CapabilityId; dependencyId: CapabilityId; versionRange: string }
  | {
    kind: "version-mismatch";
    capabilityId: CapabilityId;
    dependencyId: CapabilityId;
    versionRange: string;
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
  /** The closure ordered dependencies-first. Empty whenever there are problems. */
  installOrder: CapabilityId[];
  /** For each capability in the closure, the capabilities in the closure that directly depend on it. */
  dependents: ReadonlyMap<CapabilityId, readonly CapabilityId[]>;
  /** Every problem found, not only the first. */
  problems: ResolutionProblem[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolves `requested` against the registry: pulls in dependencies transitively, then checks every
 * dependency's version range, every declared conflict (in either direction) and every cycle. The
 * install order is deterministic: among packs whose dependencies are met, the lowest ID goes first.
 */
export function resolveDependencies(
  registry: CapabilityRegistry,
  requested: readonly CapabilityId[],
): DependencyResolution {
  const problems: ResolutionProblem[] = [];
  const closure = new Set<CapabilityId>();
  const pending = [...new Set(requested)].toSorted(byId);
  for (const id of pending) {
    if (!registry.packs.has(id)) problems.push({ kind: "unknown-capability", capabilityId: id });
  }
  while (pending.length > 0) {
    const id = pending.shift()!;
    const pack = registry.packs.get(id);
    if (pack === undefined || closure.has(id)) continue;
    closure.add(id);
    for (const { id: dependencyId, versionRange } of pack.manifest.dependencies) {
      const dependency = registry.packs.get(dependencyId);
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
      pending.push(dependencyId);
    }
  }

  const members = [...closure].toSorted(byId);
  const edges = new Map<CapabilityId, CapabilityId[]>(members.map((id) => [
    id,
    registry.packs.get(id)!.manifest.dependencies.map((d) => d.id).filter((d) => closure.has(d)).toSorted(byId),
  ]));
  const dependents = new Map<CapabilityId, CapabilityId[]>(members.map((id) => [id, []]));
  for (const id of members) for (const dependencyId of edges.get(id)!) dependents.get(dependencyId)!.push(id);

  const reportedConflicts = new Set<string>();
  for (const id of members) {
    for (const other of registry.packs.get(id)!.manifest.conflicts ?? []) {
      if (!closure.has(other)) continue;
      const [first, second] = [id, other].toSorted(byId) as [CapabilityId, CapabilityId];
      if (reportedConflicts.has(`${first} ${second}`)) continue;
      reportedConflicts.add(`${first} ${second}`);
      problems.push({ kind: "conflict", capabilityId: first, conflictsWith: second });
    }
  }

  problems.push(...findCycles(members, edges));

  return {
    closure: members,
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
