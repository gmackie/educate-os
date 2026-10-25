import { GradeBand, EducateOsError, Subject } from "@educateos/contracts";
import { LocalId } from "@educateos/curriculum";
import { LanguageTag, RightsMode } from "@educateos/registry";
import { z } from "zod";
import { type ComposedCourse, composeCourse } from "./composer.ts";
import { formatJson, LOCK_PATH, MANIFEST_PATH, type OcsFiles, readPackage } from "./package.ts";
import { type PackageSource, resolveCourse, serializeLock } from "./resolver.ts";
import {
  OCS_SPEC_VERSION,
  type OcsLock,
  type OcsManifest,
  type OcsOverride,
  OcsOverrideTarget,
  OcsPackageId,
  PlainText,
  type Sha256Digest,
} from "./schema.ts";
import { ChangeKind, compareVersions, nextVersion, SemVer } from "./semver.ts";

// The teacher-facing composition API (RFC 0001 §8). A teacher picks modules, arranges them, hides or
// renames what does not fit, previews the result and publishes. Every function here is pure over a
// draft value, and none of them, nor any message they produce, needs version-control vocabulary.

/**
 * A course being composed: the manifest, the course's own unit, activity, resource and Codex files,
 * and the lockfile and version of its last publication, if any.
 */
export interface CourseDraft {
  readonly manifest: OcsManifest;
  /** The course's own entries by path (`units/…`, `activities/…`, `resources/…`, `codex/…`). */
  readonly content: OcsFiles;
  readonly lock?: OcsLock | undefined;
  readonly published?: { version: SemVer; digest: Sha256Digest } | undefined;
  /** Packages that may move off their locked version at the next preview or publication. */
  readonly updating?: "all" | readonly OcsPackageId[] | undefined;
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new EducateOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

/** What a teacher gives to start a new course. */
export const NewCourse = z.strictObject({
  id: OcsPackageId,
  title: PlainText(200),
  language: LanguageTag,
  summary: PlainText(5000).optional(),
  subject: Subject.optional(),
  gradeBand: GradeBand.optional(),
  /** The version the first publication gets. */
  version: SemVer.default("1.0.0"),
});
/** A new course. */
export type NewCourse = z.input<typeof NewCourse>;

/** An empty course draft. */
export function startCourse(input: NewCourse): CourseDraft {
  const { version, ...course } = parseInput(NewCourse, input);
  return {
    manifest: { specVersion: OCS_SPEC_VERSION, ...course, version, standards: [], modules: [], outline: [], overrides: [] },
    content: {},
  };
}

/**
 * A draft of the next version of a published course, from its files.
 *
 * @throws OcsError `invalid-package` for invalid files.
 */
export async function editCourse(files: OcsFiles): Promise<CourseDraft> {
  const pkg = await readPackage(files);
  const content = Object.fromEntries(Object.entries(files).filter(([path]) => path !== MANIFEST_PATH && path !== LOCK_PATH));
  return { manifest: pkg.manifest, content, lock: pkg.lock, published: { version: pkg.manifest.version, digest: pkg.digest } };
}

/** A module a teacher chose from the library: a package and the version they looked at. */
export const ModuleChoice = z.strictObject({
  packageId: OcsPackageId,
  version: SemVer,
  /** The name the course uses for it. Defaults to the package's own name. */
  name: LocalId.optional(),
  /** The widest use the course may make of the module's resources. */
  rights: RightsMode.optional(),
});
/** A module choice. */
export type ModuleChoice = z.input<typeof ModuleChoice>;

const nameOf = (entry: OcsManifest["outline"][number]) => (entry.kind === "unit" ? entry.unit : entry.module);
const outlineNames = (manifest: OcsManifest) => new Set(manifest.outline.map(nameOf));

/**
 * Adds a module at the end of the course. The course accepts compatible updates of the chosen
 * version (a caret range) and keeps the version it resolved until the teacher publishes again.
 *
 * @throws EducateOsError `validation-failed` for an invalid choice or a taken name, and `conflict`
 *   if the package is already in the course.
 */
export function addModule(draft: CourseDraft, choice: ModuleChoice): CourseDraft {
  const { packageId, version, name, rights } = parseInput(ModuleChoice, choice);
  const { manifest } = draft;
  if (packageId === manifest.id) throw new EducateOsError("validation-failed", "a course cannot include itself");
  if (manifest.modules.some((module) => module.package === packageId)) throw new EducateOsError("conflict", `${packageId} is already part of this course`);
  const taken = outlineNames(manifest);
  if (name !== undefined && taken.has(name)) throw new EducateOsError("validation-failed", `the name ${name} is already used in this course`);
  const base = packageId.slice(packageId.indexOf("/") + 1);
  let chosen = name ?? base;
  for (let n = 2; taken.has(chosen); n++) chosen = `${base}-${n}`;
  return {
    ...draft,
    manifest: {
      ...manifest,
      modules: [...manifest.modules, { name: chosen, package: packageId, range: `^${version}`, ...(rights === undefined ? {} : { rights }) }],
      outline: [...manifest.outline, { kind: "module", module: chosen }],
    },
  };
}

/**
 * Removes a module, its place in the outline, and every change the course made to it.
 *
 * @throws EducateOsError `not-found` if the course has no module of that name.
 */
export function removeModule(draft: CourseDraft, name: string): CourseDraft {
  const { manifest } = draft;
  if (!manifest.modules.some((module) => module.name === name)) throw new EducateOsError("not-found", `this course has no module named ${name}`);
  return {
    ...draft,
    manifest: {
      ...manifest,
      modules: manifest.modules.filter((module) => module.name !== name),
      outline: manifest.outline.filter((entry) => entry.kind !== "module" || entry.module !== name),
      overrides: manifest.overrides.filter((override) => override.target.modules[0] !== name),
    },
  };
}

/**
 * Lets the named modules (all, if none are named) move to the newest version their range accepts
 * at the next preview or publication. Until then, the course keeps the versions it last published.
 *
 * @throws EducateOsError `not-found` if the course has no module of a given name.
 */
export function updateModules(draft: CourseDraft, names?: readonly string[]): CourseDraft {
  const { manifest } = draft;
  if (names === undefined) return { ...draft, updating: "all" };
  const packages = names.map((name) => {
    const module = manifest.modules.find((candidate) => candidate.name === name);
    if (module === undefined) throw new EducateOsError("not-found", `this course has no module named ${name}`);
    return module.package;
  });
  if (draft.updating === "all") return draft;
  return { ...draft, updating: [...new Set([...(draft.updating ?? []), ...packages])].toSorted() };
}

/** Where a reorder applies inside a module: its units, or one unit's items. */
export const ReorderWithin = z.strictObject({ modules: OcsOverrideTarget.shape.modules, unit: LocalId.optional() });
/** A reorder scope. */
export type ReorderWithin = z.input<typeof ReorderWithin>;

const sameTarget = (a: OcsOverride["target"], b: OcsOverride["target"]) =>
  a.modules.join("/") === b.modules.join("/") && a.unit === b.unit && ("item" in a ? a.item : undefined) === ("item" in b ? b.item : undefined);

const withOverride = (draft: CourseDraft, override: OcsOverride): CourseDraft => ({
  ...draft,
  manifest: {
    ...draft.manifest,
    overrides: [...draft.manifest.overrides.filter((o) => o.kind !== override.kind || !sameTarget(o.target, override.target)), override],
  },
});

/**
 * Reorders the course. Without `within`, `order` lists the course's own units and modules by name;
 * with it, the units of a module or the items of one of a module's units. The listed entries come
 * first, in the given order, and the rest follow in their current order.
 *
 * @throws EducateOsError `validation-failed` if a name is not in the course outline.
 */
export function reorder(draft: CourseDraft, order: readonly string[], within?: ReorderWithin): CourseDraft {
  const ids = parseInput(z.array(LocalId).min(1).refine((list) => new Set(list).size === list.length, "a name is listed more than once"), order);
  if (within !== undefined) return withOverride(draft, { kind: "reorder", target: parseInput(ReorderWithin, within), order: ids });
  const { manifest } = draft;
  const names = outlineNames(manifest);
  const missing = ids.find((id) => !names.has(id));
  if (missing !== undefined) throw new EducateOsError("validation-failed", `${missing} is not part of this course`);
  const rank = (entry: OcsManifest["outline"][number]) => {
    const at = ids.indexOf(nameOf(entry));
    return at === -1 ? ids.length : at;
  };
  const outline = manifest.outline.map((entry, index) => ({ entry, index })).toSorted((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index);
  return { ...draft, manifest: { ...manifest, outline: outline.map(({ entry }) => entry) } };
}

/** Hides a unit or item a module contributes. */
export function hide(draft: CourseDraft, target: OcsOverrideTarget): CourseDraft {
  return withOverride(draft, { kind: "hide", target: parseInput(OcsOverrideTarget, target) });
}

/** Gives a unit or item a module contributes a different title in this course. */
export function rename(draft: CourseDraft, target: OcsOverrideTarget, title: string): CourseDraft {
  return withOverride(draft, { kind: "rename", target: parseInput(OcsOverrideTarget, target), title: parseInput(PlainText(200), title) });
}

/** How a module's version moves between the last publication and a preview. */
export interface ModuleChange {
  kind: "added" | "removed" | "updated";
  packageId: OcsPackageId;
  from?: SemVer;
  to?: SemVer;
}

/** What publishing the draft now would produce. */
export interface CoursePreview {
  course: ComposedCourse;
  lock: OcsLock;
  /** Module versions that differ from the last publication, sorted by package ID. */
  changes: ModuleChange[];
}

const draftFiles = (draft: CourseDraft, manifest: OcsManifest = draft.manifest): Record<string, string> => ({
  ...draft.content,
  [MANIFEST_PATH]: formatJson(manifest),
});

function moduleChanges(before: OcsLock | undefined, after: OcsLock): ModuleChange[] {
  const old = new Map((before?.packages ?? []).map((entry) => [entry.id, entry.version]));
  const now = new Map(after.packages.map((entry) => [entry.id, entry.version]));
  const changes: ModuleChange[] = [];
  for (const id of [...new Set([...old.keys(), ...now.keys()])].toSorted()) {
    const from = old.get(id);
    const to = now.get(id);
    if (from === undefined) changes.push({ kind: "added", packageId: id, to: to! });
    else if (to === undefined) changes.push({ kind: "removed", packageId: id, from });
    else if (from !== to) changes.push({ kind: "updated", packageId: id, from, to });
  }
  return changes;
}

async function build(draft: CourseDraft, manifest: OcsManifest, source: PackageSource) {
  const files = draftFiles(draft, manifest);
  const { lock, updating } = draft;
  const locked = lock === undefined || updating === "all" ? undefined : { ...lock, packages: lock.packages.filter((entry) => !updating?.includes(entry.id)) };
  const resolution = await resolveCourse(await readPackage(files), source, { locked });
  return { files, resolution, course: composeCourse(resolution) };
}

/**
 * Puts the draft together as it would be published: resolves its modules (keeping the versions
 * of the last publication where they still fit), composes the outline, and lists module changes.
 *
 * @throws OcsError as {@link resolveCourse} and {@link composeCourse}, with a message a teacher
 *   can act on.
 */
export async function preview(draft: CourseDraft, source: PackageSource): Promise<CoursePreview> {
  const { resolution, course } = await build(draft, draft.manifest, source);
  return { course, lock: resolution.lock, changes: moduleChanges(draft.lock, resolution.lock) };
}

/** A publication: the new package version, ready to add to the library. */
export interface PublishedCourse {
  version: SemVer;
  /** The package files, `ocs.lock` included. */
  files: Record<string, string>;
  digest: Sha256Digest;
  lock: OcsLock;
  course: ComposedCourse;
  /** The draft to keep editing, now pinned to this publication. */
  draft: CourseDraft;
}

/** Options for {@link publish}. */
export const PublishOptions = z.strictObject({
  /** What kind of change this is, which decides the next version. Ignored for a first publication. */
  change: ChangeKind.default("addition"),
});
/** Publish options. */
export type PublishOptions = z.input<typeof PublishOptions>;

/**
 * Publishes the draft as a new package version with a fresh lockfile. The first publication uses
 * the draft's version; each later one follows from the kind of change. Adding the result to a
 * library is the caller's step, so a failed save leaves the draft as it was.
 *
 * @throws OcsError as {@link preview}.
 */
export async function publish(draft: CourseDraft, source: PackageSource, options: PublishOptions = {}): Promise<PublishedCourse> {
  const { change } = parseInput(PublishOptions, options);
  const previous = draft.published?.version;
  const version = previous === undefined || compareVersions(draft.manifest.version, previous) > 0 ? draft.manifest.version : nextVersion(previous, change);
  const manifest: OcsManifest = { ...draft.manifest, version };
  const { files, resolution, course } = await build(draft, manifest, source);
  const lock = resolution.lock;
  return {
    version,
    files: { ...files, [LOCK_PATH]: serializeLock(lock) },
    digest: resolution.root.digest,
    lock,
    course,
    draft: { manifest, content: draft.content, lock, published: { version, digest: resolution.root.digest } },
  };
}
