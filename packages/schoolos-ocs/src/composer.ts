import type { AlignmentRequest } from "@schoolos/curriculum";
import { RightsMode } from "@schoolos/registry";
import { OcsError } from "./errors.ts";
import { type OcsPackage, outlineKey } from "./package.ts";
import type { Resolution } from "./resolver.ts";
import type { OcsActivity, OcsCodexNote, OcsOverride, OcsPackageId, OcsResource, Sha256Digest } from "./schema.ts";

/** Which package, at which locked version and content, a composed unit or item comes from. */
export interface Provenance {
  packageId: OcsPackageId;
  version: string;
  digest: Sha256Digest;
  /** The module names from the course down to that package; empty for the course's own content. */
  modules: string[];
}

interface ItemBase {
  /** The item's place in the course, as {@link outlineKey} writes it. */
  key: string;
  title: string;
  /** Whether an override changed the title from the one its package gave it. */
  renamed: boolean;
  provenance: Provenance;
}

/** One item of a composed unit. */
export type ComposedItem =
  | (ItemBase & { kind: "activity"; activity: OcsActivity })
  | (ItemBase & {
    kind: "resource";
    resource: OcsResource;
    /**
     * The use the course may make of the resource: the narrowest of the use its package declares
     * and every module rights cap between the course and that package.
     */
    use: RightsMode;
  })
  | (ItemBase & { kind: "codex"; note: OcsCodexNote });

/** One unit of a composed course. */
export interface ComposedUnit {
  key: string;
  unitId: string;
  title: string;
  renamed: boolean;
  summary?: string;
  standards: AlignmentRequest[];
  items: ComposedItem[];
  provenance: Provenance;
}

/** A course flattened from its locked module graph: one ordered outline. */
export interface ComposedCourse {
  packageId: OcsPackageId;
  version: string;
  title: string;
  language: string;
  subject?: string;
  gradeBand?: string;
  /** The course's standards and those of every unit it shows, each once, in first-seen order. */
  standards: AlignmentRequest[];
  units: ComposedUnit[];
  /** Keys of the units and items an override hid. */
  hidden: string[];
  /**
   * Keys of units left out because the same unit of the same package already appears earlier,
   * as happens when two modules include a shared one.
   */
  repeated: string[];
}

type Working<T> = T & { hidden: boolean };
type WorkingUnit = Working<Omit<ComposedUnit, "items">> & { modules: string[]; items: Working<ComposedItem>[] };

const RIGHTS = RightsMode.options;
const narrowest = (a: RightsMode, b: RightsMode): RightsMode => (RIGHTS.indexOf(a) <= RIGHTS.indexOf(b) ? a : b);
const WIDEST = RIGHTS.at(-1)!;

interface Context {
  packages: ReadonlyMap<OcsPackageId, OcsPackage>;
  versions: ReadonlyMap<OcsPackageId, string>;
}

function buildUnit(pkg: OcsPackage, unitId: string, modules: string[], cap: RightsMode): WorkingUnit {
  const unit = pkg.units.get(unitId)!;
  const provenance: Provenance = { packageId: pkg.manifest.id, version: pkg.manifest.version, digest: pkg.digest, modules };
  const key = outlineKey({ modules, unit: unitId });
  const items = unit.items.map((item): Working<ComposedItem> => {
    const base = { key: outlineKey({ modules, unit: unitId, item: item.ref }), renamed: false, provenance, hidden: false };
    switch (item.kind) {
      case "activity": {
        const activity = pkg.activities.get(item.ref)!;
        return { ...base, kind: "activity", title: activity.title, activity };
      }
      case "resource": {
        const resource = pkg.resources.get(item.ref)!;
        return { ...base, kind: "resource", title: resource.title, resource, use: narrowest(resource.use, cap) };
      }
      case "codex": {
        const note = pkg.codex.get(item.ref)!;
        return { ...base, kind: "codex", title: note.title, note };
      }
    }
  });
  return {
    key,
    unitId,
    title: unit.title,
    renamed: false,
    ...(unit.summary === undefined ? {} : { summary: unit.summary }),
    standards: unit.standards,
    items,
    provenance,
    modules,
    hidden: false,
  };
}

/** Moves the entries whose ID is listed to the front, in the listed order, within their own slots. */
function reorderSlots<T>(list: T[], inScope: (entry: T) => boolean, idOf: (entry: T) => string, order: readonly string[]): string | undefined {
  const slots = list.flatMap((entry, index) => (inScope(entry) ? [index] : []));
  const entries = slots.map((index) => list[index]!);
  const ids = new Set(entries.map(idOf));
  const missing = order.find((id) => !ids.has(id));
  if (missing !== undefined) return missing;
  const rank = (entry: T) => {
    const at = order.indexOf(idOf(entry));
    return at === -1 ? order.length : at;
  };
  const sorted = entries.map((entry, index) => ({ entry, index })).toSorted((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index);
  slots.forEach((slot, index) => {
    list[slot] = sorted[index]!.entry;
  });
  return undefined;
}

function applyOverride(pkg: OcsPackage, path: string[], units: WorkingUnit[], override: OcsOverride): void {
  const modules = [...path, ...override.target.modules];
  const fail = (target: string, reason: string) => new OcsError({ kind: "invalid-change", packageId: pkg.manifest.id, target, reason });
  if (override.kind === "reorder" && override.target.unit === undefined) {
    const scope = modules.join("/");
    const missing = reorderSlots(units, (unit) => unit.modules.join("/") === scope, (unit) => unit.unitId, override.order);
    if (missing !== undefined) throw fail(`${scope}:${missing}`, "that unit is not in the module");
    return;
  }
  const unitKey = outlineKey({ modules, unit: override.target.unit! });
  const unit = units.find((candidate) => candidate.key === unitKey);
  if (unit === undefined) throw fail(unitKey, "there is no such unit in the course");
  if (override.kind === "reorder") {
    const missing = reorderSlots(unit.items, () => true, (item) => item.key.slice(item.key.indexOf("#") + 1), override.order);
    if (missing !== undefined) throw fail(`${unitKey}#${missing}`, "that item is not in the unit");
    return;
  }
  const itemId = override.target.item;
  const target = itemId === undefined ? unit : unit.items.find((item) => item.key === `${unitKey}#${itemId}`);
  if (target === undefined) throw fail(`${unitKey}#${itemId}`, "there is no such item in the unit");
  if (override.kind === "hide") target.hidden = true;
  else {
    target.title = override.title;
    target.renamed = true;
  }
}

/**
 * One package's outline: its own units and its modules' outlines in manifest order, after its own
 * overrides. A module's overrides apply first, so the including package always has the last word.
 */
function composePackage(pkg: OcsPackage, path: string[], cap: RightsMode, context: Context): WorkingUnit[] {
  const units: WorkingUnit[] = [];
  for (const entry of pkg.manifest.outline) {
    if (entry.kind === "unit") {
      units.push(buildUnit(pkg, entry.unit, path, cap));
      continue;
    }
    const module = pkg.manifest.modules.find((candidate) => candidate.name === entry.module)!;
    const child = context.packages.get(module.package);
    if (child === undefined || context.versions.get(module.package) !== child.manifest.version) {
      throw new OcsError({ kind: "unknown-package", packageId: module.package });
    }
    units.push(...composePackage(child, [...path, module.name], narrowest(cap, module.rights ?? WIDEST), context));
  }
  for (const override of pkg.manifest.overrides) applyOverride(pkg, path, units, override);
  return units;
}

/**
 * Flattens a resolved course into one outline (RFC 0001 §7). Units appear in the order the
 * manifests give, overrides hide, reorder and rename what modules contribute, and every unit and
 * item records the package version it came from. Composition reads only the resolution, so a
 * course composed from the same lockfile is always the same.
 *
 * @throws OcsError `invalid-change` for an override that matches nothing, which happens when a
 *   module's new version drops or renames what the override named.
 */
export function composeCourse(resolution: Resolution): ComposedCourse {
  const { root, packages, lock } = resolution;
  const versions = new Map(lock.packages.map((entry) => [entry.id, entry.version]));
  const working = composePackage(root, [], WIDEST, { packages, versions });

  const hidden: string[] = [];
  const repeated: string[] = [];
  const seen = new Set<string>();
  const units: ComposedUnit[] = [];
  for (const unit of working) {
    if (unit.hidden) {
      hidden.push(unit.key);
      continue;
    }
    const identity = `${unit.provenance.packageId}:${unit.unitId}`;
    if (seen.has(identity)) {
      repeated.push(unit.key);
      continue;
    }
    seen.add(identity);
    const items: ComposedItem[] = [];
    for (const { hidden: isHidden, ...item } of unit.items) {
      if (isHidden) hidden.push(item.key);
      else items.push(item);
    }
    const { hidden: _hidden, modules: _modules, items: _items, ...rest } = unit;
    units.push({ ...rest, items });
  }

  const standards: AlignmentRequest[] = [];
  const known = new Set<string>();
  for (const standard of [...root.manifest.standards, ...units.flatMap((unit) => unit.standards)]) {
    const key = `${standard.frameworkKey} ${standard.competencyUri}`;
    if (known.has(key)) continue;
    known.add(key);
    standards.push(standard);
  }

  const { manifest } = root;
  return {
    packageId: manifest.id,
    version: manifest.version,
    title: manifest.title,
    language: manifest.language,
    ...(manifest.subject === undefined ? {} : { subject: manifest.subject }),
    ...(manifest.gradeBand === undefined ? {} : { gradeBand: manifest.gradeBand }),
    standards,
    units,
    hidden,
    repeated,
  };
}
