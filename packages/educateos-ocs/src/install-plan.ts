// Installing a composed course in a district (OCS 1.1, RFC 0001 §13.1 and §14): what the district
// must import, create and install, in order, and the interface it does that through. District I/O
// stays out of this package: `CourseInstallTarget` is implemented by the district (over its
// curriculum and course-content services), and `InMemoryCourseInstallTarget` is the reference
// implementation the tests use.
import { ActivityDefinitionId, EducateOsError, ResourceId, RubricId } from "@educateos/contracts";
import { type ActivityContent, type AlignmentRequest, checkActivityContent, generateActivity, type TemplateInput } from "@educateos/curriculum";
import type { RightsMode } from "@educateos/registry";
import { type ActivityExport, type ActivityExportSource, type ParsedActivityExport, readActivityExport, templateInputFor } from "./activity-export.ts";
import type { ComposedCourse, Provenance } from "./composer.ts";
import { OcsError } from "./errors.ts";
import { type DistrictDefinitionRef, isPortable, type OcsActivity, type OcsResource, type PortableActivityRef, portableKey } from "./schema.ts";

/** A portable activity's export, fetched and verified against the reference that names it. */
export interface VerifiedActivityExport extends ParsedActivityExport {
  /** The mapping key, `id@version`. */
  key: string;
  ref: PortableActivityRef;
}

/** Every portable reference in a composed course, once each, in course order. */
export function portableRefs(course: ComposedCourse): PortableActivityRef[] {
  const refs = new Map<string, PortableActivityRef>();
  for (const unit of course.units) {
    for (const item of unit.items) {
      if (item.kind !== "activity" || !isPortable(item.activity.definition)) continue;
      const ref = item.activity.definition.portable;
      if (!refs.has(portableKey(ref))) refs.set(portableKey(ref), ref);
    }
  }
  return [...refs.values()];
}

/**
 * Fetches the export of every portable activity in a composed course and verifies each: the text
 * must have the digest the source recorded and the digest the course's reference pins, and must be
 * the export it was asked for. Composition never needs exports; installation does.
 *
 * @throws OcsError `unknown-export`, `export-mismatch` (including two references that pin
 *   different digests for one version), or `invalid-export`.
 */
export async function resolveActivityExports(course: ComposedCourse, source: ActivityExportSource): Promise<ReadonlyMap<string, VerifiedActivityExport>> {
  const resolved = new Map<string, VerifiedActivityExport>();
  const pinned = new Map<string, string>();
  for (const unit of course.units) {
    for (const item of unit.items) {
      if (item.kind !== "activity" || !isPortable(item.activity.definition)) continue;
      const ref = item.activity.definition.portable;
      const key = portableKey(ref);
      const earlier = pinned.get(key);
      if (earlier !== undefined && earlier !== ref.digest) {
        throw new OcsError({ kind: "export-mismatch", exportId: ref.id, version: ref.version, reason: `two parts of the course pin different content for it (${earlier} and ${ref.digest})` });
      }
      pinned.set(key, ref.digest);
    }
  }
  for (const ref of portableRefs(course)) {
    const published = await source.getExport(ref.id, ref.version);
    if (published === undefined) throw new OcsError({ kind: "unknown-export", exportId: ref.id, version: ref.version });
    const parsed = await readActivityExport(published.text);
    const mismatch = (reason: string) => new OcsError({ kind: "export-mismatch", exportId: ref.id, version: ref.version, reason });
    if (parsed.digest !== published.digest) throw mismatch(`its content does not match the fingerprint recorded when it was published (expected ${published.digest}, found ${parsed.digest})`);
    if (parsed.digest !== ref.digest) throw mismatch(`its content is not the content the course names (expected ${ref.digest}, found ${parsed.digest})`);
    if (parsed.export.id !== ref.id || parsed.export.version !== ref.version) throw mismatch(`it is actually ${parsed.export.id} ${parsed.export.version}`);
    resolved.set(portableKey(ref), { ...parsed, key: portableKey(ref), ref });
  }
  return resolved;
}

/** One portable activity the district imports as a draft definition, once, whatever uses it. */
export interface PlannedImport {
  /** The stable mapping key, `id@version`. The district records its local definition under it. */
  key: string;
  ref: PortableActivityRef;
  export: ActivityExport;
  /** The first course item that uses it. */
  firstItemKey: string;
}

interface PlannedItemBase {
  /** The course item, as `outlineKey` writes it. */
  key: string;
  title: string;
  provenance: Provenance;
}

/** An activity to install and place: from an import of the plan, or a district-local definition. */
export type PlannedActivity = PlannedItemBase & {
  kind: "activity";
  role: OcsActivity["role"];
  definition: { kind: "portable"; importKey: string } | ({ kind: "district" } & DistrictDefinitionRef);
};
/** A student-visible Codex note (`purpose: context`, `visibility: students`), placed as a page. */
export type PlannedPage = PlannedItemBase & { kind: "page"; body: string };
/** A teacher-only Codex note: context for teachers, or an answer key. Never shown to students. */
export type PlannedTeacherNote = PlannedItemBase & { kind: "teacher-note"; body: string; purpose: "context" | "answer-key" };
/** A resource release the course uses, with the use the course may make of it. */
export type PlannedResource = PlannedItemBase & { kind: "resource"; resource: OcsResource; use: RightsMode };
/** One item of a planned unit. */
export type PlannedItem = PlannedActivity | PlannedPage | PlannedTeacherNote | PlannedResource;

/** One unit, which the district creates as one course module, with its items in order. */
export interface PlannedUnit {
  key: string;
  unitId: string;
  title: string;
  summary?: string;
  standards: AlignmentRequest[];
  provenance: Provenance;
  items: PlannedItem[];
}

/** Everything a district does to install a composed course, in order. */
export interface CourseInstallPlan {
  course: Pick<ComposedCourse, "packageId" | "version" | "title" | "language" | "subject" | "gradeBand" | "standards">;
  /** Every portable activity, once, in first-use order. */
  imports: PlannedImport[];
  units: PlannedUnit[];
  /** Keys of activity items left out because the same definition is installed earlier in the course. */
  repeated: string[];
}

/**
 * Plans a composed course's installation: per unit, its items in order (activities, Codex notes as
 * student pages or teacher-only notes, resources), and per portable activity, the verified export to
 * import as a draft. An activity whose definition already appears earlier is installed once, at its
 * first place, as `planInstallations` does.
 *
 * @throws OcsError `unknown-export` if `exports` lacks a portable activity's export, and
 *   `export-mismatch` if it holds other content than the reference pins.
 */
export function planCourseInstall(course: ComposedCourse, exports: ReadonlyMap<string, VerifiedActivityExport>): CourseInstallPlan {
  const imports = new Map<string, PlannedImport>();
  const installed = new Set<string>();
  const repeated: string[] = [];
  const units = course.units.map((unit): PlannedUnit => {
    const items: PlannedItem[] = [];
    for (const item of unit.items) {
      const base = { key: item.key, title: item.title, provenance: item.provenance };
      switch (item.kind) {
        case "activity": {
          const { definition } = item.activity;
          if (isPortable(definition)) {
            const ref = definition.portable;
            const key = portableKey(ref);
            const verified = exports.get(key);
            if (verified === undefined) throw new OcsError({ kind: "unknown-export", exportId: ref.id, version: ref.version });
            if (verified.digest !== ref.digest) {
              throw new OcsError({ kind: "export-mismatch", exportId: ref.id, version: ref.version, reason: `its content is not the content the course names (expected ${ref.digest}, found ${verified.digest})` });
            }
            if (!imports.has(key)) imports.set(key, { key, ref, export: verified.export, firstItemKey: item.key });
            if (installed.has(`portable:${key}`)) {
              repeated.push(item.key);
              continue;
            }
            installed.add(`portable:${key}`);
            items.push({ ...base, kind: "activity", role: item.activity.role, definition: { kind: "portable", importKey: key } });
          } else {
            const key = `district:${definition.definitionId}@${definition.version}`;
            if (installed.has(key)) {
              repeated.push(item.key);
              continue;
            }
            installed.add(key);
            items.push({ ...base, kind: "activity", role: item.activity.role, definition: { kind: "district", ...definition } });
          }
          break;
        }
        case "codex":
          items.push(item.note.visibility === "students"
            ? { ...base, kind: "page", body: item.note.body }
            : { ...base, kind: "teacher-note", body: item.note.body, purpose: item.note.purpose });
          break;
        case "resource":
          items.push({ ...base, kind: "resource", resource: item.resource, use: item.use });
          break;
      }
    }
    return {
      key: unit.key,
      unitId: unit.unitId,
      title: unit.title,
      ...(unit.summary === undefined ? {} : { summary: unit.summary }),
      standards: unit.standards,
      provenance: unit.provenance,
      items,
    };
  });
  const { packageId, version, title, language, subject, gradeBand, standards } = course;
  return {
    course: { packageId, version, title, language, ...(subject === undefined ? {} : { subject }), ...(gradeBand === undefined ? {} : { gradeBand }), standards },
    imports: [...imports.values()],
    units,
    repeated,
  };
}

/**
 * What a district implements to install a course plan: its curriculum service (import, publish,
 * install) and its course content (modules, pages, teacher notes, resources), acting for one
 * teacher or administrator in one offering. Every call is authorized and validated by the
 * district's own services; nothing here bypasses them.
 */
export interface CourseInstallTarget {
  /**
   * Imports an export as a new draft definition in the district's own curriculum service (with
   * `templateInputFor`): its readings become the district's releases, its rubric the district's
   * rubric release, and its alignments resolve only against the district's approved catalog.
   * Never reuses a foreign definition ID.
   */
  importDraft(item: PlannedImport): Promise<DistrictDefinitionRef>;
  /** Publishes a draft after review. Returns the published version. */
  publish(draft: DistrictDefinitionRef): Promise<DistrictDefinitionRef>;
  /** Creates the course module a unit becomes. */
  createModule(unit: PlannedUnit): Promise<{ moduleId: string }>;
  /** Adds a student-visible page to a module. */
  addPage(moduleId: string, page: PlannedPage): Promise<void>;
  /** Adds a teacher-only note (a teacher guide or an answer key) to a module. Students never see it. */
  addTeacherNote(moduleId: string, note: PlannedTeacherNote): Promise<void>;
  /** Places a resource release in a module. */
  addResource(moduleId: string, item: PlannedResource): Promise<void>;
  /** Installs a published definition version in the offering and places it in the module. */
  install(moduleId: string, definition: DistrictDefinitionRef, item: PlannedActivity): Promise<{ activityId: string }>;
}

/** The local definition a district recorded for a portable activity. */
export interface InstallMapping {
  /** The plan's import key, `id@version`. */
  key: string;
  ref: PortableActivityRef;
  definition: DistrictDefinitionRef;
  status: "draft" | "published";
}

/** Options for {@link importPlannedActivities} and {@link applyInstallPlan}. */
export interface InstallOptions {
  /** Mappings an earlier run recorded. Their exports are not imported again. */
  mappings?: readonly InstallMapping[] | undefined;
  /**
   * Whether to publish imported drafts now, as an administrator who reviewed the course does.
   * Without it, drafts wait for review and the activities that use them are left pending.
   */
  publishDrafts: boolean;
  /** Units to leave out, such as the units a district already teaches. Their imports are skipped too. */
  skipUnit?: ((unit: PlannedUnit) => boolean) | undefined;
}

/** What an installation did. Keep `mappings` to resume, or to install the pending activities later. */
export interface CourseInstallRecord {
  mappings: InstallMapping[];
  modules: { unitKey: string; moduleId: string }[];
  installed: { itemKey: string; activityId: string; definition: DistrictDefinitionRef }[];
  /** Activities not installed because their imported draft is not published yet. */
  pending: { itemKey: string; importKey: string }[];
  skippedUnits: string[];
}

const neededImports = (units: readonly PlannedUnit[]) =>
  new Set(units.flatMap((unit) => unit.items.flatMap((item) => (item.kind === "activity" && item.definition.kind === "portable" ? [item.definition.importKey] : []))));

/**
 * Imports the plan's portable activities as drafts (those the kept units use and no mapping already
 * covers), and publishes drafts if asked. Returns every mapping, earlier ones included, in plan order.
 *
 * @throws EducateOsError `conflict` if an earlier mapping is for other content than the plan names,
 *   and whatever the target throws.
 */
export async function importPlannedActivities(plan: CourseInstallPlan, target: CourseInstallTarget, options: InstallOptions): Promise<InstallMapping[]> {
  const skip = options.skipUnit ?? (() => false);
  const needed = neededImports(plan.units.filter((unit) => !skip(unit)));
  const mappings = new Map((options.mappings ?? []).map((mapping) => [mapping.key, mapping]));
  for (const planned of plan.imports) {
    let mapping = mappings.get(planned.key);
    if (mapping !== undefined && mapping.ref.digest !== planned.ref.digest) {
      throw new EducateOsError("conflict", `${planned.key} was imported with other content (${mapping.ref.digest}) than this course names (${planned.ref.digest})`);
    }
    if (!needed.has(planned.key)) continue;
    mapping ??= { key: planned.key, ref: planned.ref, definition: await target.importDraft(planned), status: "draft" };
    if (mapping.status === "draft" && options.publishDrafts) mapping = { ...mapping, definition: await target.publish(mapping.definition), status: "published" };
    mappings.set(planned.key, mapping);
  }
  const order = new Map(plan.imports.map((planned, index) => [planned.key, index]));
  return [...mappings.values()].toSorted((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
}

/**
 * Installs a course plan through the district's target: imports (as {@link importPlannedActivities}),
 * then, unit by unit, creates its module and adds its items in order. A portable activity is
 * installed once its imported draft is published; until then it is reported as pending. If a call
 * fails, what was done before it stays done, and the error is rethrown.
 *
 * @throws whatever {@link importPlannedActivities} and the target throw.
 */
export async function applyInstallPlan(plan: CourseInstallPlan, target: CourseInstallTarget, options: InstallOptions): Promise<CourseInstallRecord> {
  const skip = options.skipUnit ?? (() => false);
  const mappings = await importPlannedActivities(plan, target, options);
  const byKey = new Map(mappings.map((mapping) => [mapping.key, mapping]));
  const record: CourseInstallRecord = { mappings, modules: [], installed: [], pending: [], skippedUnits: [] };
  for (const unit of plan.units) {
    if (skip(unit)) {
      record.skippedUnits.push(unit.key);
      continue;
    }
    const { moduleId } = await target.createModule(unit);
    record.modules.push({ unitKey: unit.key, moduleId });
    for (const item of unit.items) {
      switch (item.kind) {
        case "page":
          await target.addPage(moduleId, item);
          break;
        case "teacher-note":
          await target.addTeacherNote(moduleId, item);
          break;
        case "resource":
          await target.addResource(moduleId, item);
          break;
        case "activity": {
          let definition: DistrictDefinitionRef;
          if (item.definition.kind === "district") {
            definition = { definitionId: item.definition.definitionId, version: item.definition.version };
          } else {
            const mapping = byKey.get(item.definition.importKey);
            if (mapping?.status !== "published") {
              record.pending.push({ itemKey: item.key, importKey: item.definition.importKey });
              break;
            }
            definition = mapping.definition;
          }
          const { activityId } = await target.install(moduleId, definition, item);
          record.installed.push({ itemKey: item.key, activityId, definition });
          break;
        }
      }
    }
  }
  return record;
}

/** A definition the in-memory target holds. */
export interface InMemoryDefinition {
  definitionId: string;
  version: number;
  status: "draft" | "published";
  /** The import key it was created from. */
  importKey: string;
  input: TemplateInput;
  content: ActivityContent;
}

/** A module the in-memory target holds, with what was added to it, in order. */
export interface InMemoryModule {
  moduleId: string;
  title: string;
  items: (
    | { kind: "page"; title: string; body: string }
    | { kind: "teacher-note"; title: string; body: string; purpose: "context" | "answer-key" }
    | { kind: "resource"; title: string }
    | { kind: "activity"; title: string; activityId: string; definition: DistrictDefinitionRef }
  )[];
}

/**
 * The reference {@link CourseInstallTarget}, in memory. It does what a district's must: it creates
 * each draft from {@link templateInputFor} and the curriculum's own template generator (so an
 * export that would not make a valid activity fails here as it would in a district), binds each
 * reading to a release and the rubric to a rubric release of its own, publishes only drafts, and
 * installs only published versions.
 */
export class InMemoryCourseInstallTarget implements CourseInstallTarget {
  readonly definitions = new Map<string, InMemoryDefinition>();
  readonly modules: InMemoryModule[] = [];
  /** Competency URIs the district's catalog holds; when set, an export aligned to another is refused. */
  readonly #catalog: ReadonlySet<string> | undefined;
  #next = 0;

  constructor(options: { catalog?: Iterable<string> } = {}) {
    this.#catalog = options.catalog === undefined ? undefined : new Set(options.catalog);
  }

  #id(prefix: string): string {
    this.#next++;
    return `${prefix}_mem-${this.#next}`;
  }

  async importDraft(item: PlannedImport): Promise<DistrictDefinitionRef> {
    const exported = item.export;
    for (const alignment of exported.alignments) {
      if (this.#catalog !== undefined && !this.#catalog.has(alignment.competencyUri)) {
        throw new EducateOsError("validation-failed", `${alignment.competencyUri} is not in this district's approved catalog`);
      }
    }
    const readings = new Map(exported.readings.map((reading) => [reading.id, { resourceId: ResourceId.parse(this.#id("rsc")), version: "1.0.0" }]));
    const rubric = exported.rubric === undefined ? undefined : { rubricId: RubricId.parse(this.#id("rbr")), version: 1 };
    const input = templateInputFor(exported, { readings, rubric });
    const content = generateActivity(input);
    const issues = checkActivityContent(content);
    if (issues.length > 0) throw new EducateOsError("validation-failed", `${item.key} does not make a valid activity: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    const definitionId = ActivityDefinitionId.parse(this.#id("adf"));
    this.definitions.set(definitionId, { definitionId, version: 1, status: "draft", importKey: item.key, input, content });
    return { definitionId, version: 1 };
  }

  async publish(draft: DistrictDefinitionRef): Promise<DistrictDefinitionRef> {
    const found = this.definitions.get(draft.definitionId);
    if (found === undefined || found.version !== draft.version) throw new EducateOsError("not-found", "no such activity");
    if (found.status === "published") throw new EducateOsError("conflict", "this version is already published");
    found.status = "published";
    return draft;
  }

  async createModule(unit: PlannedUnit): Promise<{ moduleId: string }> {
    const moduleId = this.#id("cmod");
    this.modules.push({ moduleId, title: unit.title, items: [] });
    return { moduleId };
  }

  #module(moduleId: string): InMemoryModule {
    const found = this.modules.find((module) => module.moduleId === moduleId);
    if (found === undefined) throw new EducateOsError("not-found", "no such module");
    return found;
  }

  async addPage(moduleId: string, page: PlannedPage): Promise<void> {
    this.#module(moduleId).items.push({ kind: "page", title: page.title, body: page.body });
  }

  async addTeacherNote(moduleId: string, note: PlannedTeacherNote): Promise<void> {
    this.#module(moduleId).items.push({ kind: "teacher-note", title: note.title, body: note.body, purpose: note.purpose });
  }

  async addResource(moduleId: string, item: PlannedResource): Promise<void> {
    this.#module(moduleId).items.push({ kind: "resource", title: item.title });
  }

  async install(moduleId: string, definition: DistrictDefinitionRef, item: PlannedActivity): Promise<{ activityId: string }> {
    const module = this.#module(moduleId);
    const found = this.definitions.get(definition.definitionId);
    if (found !== undefined && (found.status !== "published" || found.version !== definition.version)) {
      throw new EducateOsError("conflict", "only a published version can be installed");
    }
    const activityId = this.#id("act");
    module.items.push({ kind: "activity", title: item.title, activityId, definition });
    return { activityId };
  }
}
