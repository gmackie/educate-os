// Installing a library course into a class (SCHO-331, RFC 0001 §13.1 and §14): the district's
// `CourseInstallTarget` over its own curriculum, Content Studio, assessment and course content
// services, acting as the class's teacher. Nothing here bypasses them: every draft, publication,
// installation, assignment, module and page is authorized and validated by the service that makes it,
// exactly as if the teacher had made it by hand.
//
// What an install does, per unit of the course, in order: one unpublished module; each student
// Codex note as a page; each teacher guide and answer key as a teacher-only note, which students
// never see; and each activity imported (once per class) as a draft definition from its portable
// export, its readings imported as the district's own Content Studio releases and its rubric signed
// as the district's own rubric release, published, installed and assigned in the class, and placed
// in the module. The teacher's explicit install is the review that publishes the drafts for that
// class; the class's install record says who installed and when.
//
// Only adds. A unit whose title a module of the class already has (a showcase class's units 1 and 2)
// is skipped, and nothing is ever edited or removed. Every step is recorded as it is done, so a
// request that stops part way (or installs only `maxUnits` units) is resumed by the next one, which
// does only what is missing; the portable-to-local definition mapping is kept per class, so a later
// install of a course naming the same export version reuses the class's definition.
import type { AssessmentService } from "@educateos/assessment";
import type { RubricDraft } from "@educateos/assessment-ci";
import { randomIdBody, type ContentStudio, type ImportFetch } from "@educateos/content-studio";
import { ActivityDefinitionId, EducateOsError, RubricId, type Caller, type DistrictDirectorySnapshot } from "@educateos/contracts";
import type { CourseContentService, CourseOutline, CurriculumService, OfferingScope, ResourceReleaseRef, RubricRef, TemplateInput } from "@educateos/curriculum";
import {
  applyInstallPlan,
  type CourseInstallPlan,
  type CourseInstallTarget,
  DistrictDefinitionRef,
  type InstallMapping,
  type PlannedActivity,
  type PlannedImport,
  type PlannedPage,
  type PlannedResource,
  type PlannedTeacherNote,
  type PlannedUnit,
  templateInputFor,
} from "@educateos/ocs";
import { installAndAssign } from "./adapters.ts";
import { type CourseLibraryStore, type InstalledCourse, type InstalledUnit, type OfferingCourseInstalls, standardsBody } from "./course-library.ts";
import { AssignmentSettingsInput, type CourseInstallPlanBody, type CourseInstallUnitBody } from "./routes.ts";

/** Where an install's readings are served from, in the district's own process: a reserved name, never fetched. */
export const COURSE_READINGS_ORIGIN = "https://course-readings.example";

/** The in-process URL of one reading of an export. */
export const readingUrl = (exportId: string, version: string, readingId: string): string => `${COURSE_READINGS_ORIGIN}/${exportId}/${version}/${readingId}`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The Content Studio fetch an install imports its readings with: each reading of the plan's
 * exports, answered in-process as a small HTML page (its title, attribution and paragraphs, all
 * escaped), and every other URL refused. Nothing is fetched from the network, and the reading still
 * goes through the Studio's whole pipeline: quarantine, checks and the teacher's approval.
 */
export function readingsFetch(imports: readonly PlannedImport[], language = "en"): ImportFetch {
  const pages = new Map<string, string>();
  for (const { export: exported } of imports) {
    for (const reading of exported.readings) {
      const paragraphs = reading.body.split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p.trim())}</p>`).join("");
      const author = reading.attribution === undefined ? "" : `<meta name="author" content="${escapeHtml(reading.attribution)}">`;
      pages.set(
        readingUrl(exported.id, exported.version, reading.id),
        `<!doctype html><html lang="${escapeHtml(exported.language || language)}"><head><meta charset="utf-8"><title>${escapeHtml(reading.title)}</title>${author}</head><body><h1>${escapeHtml(reading.title)}</h1>${paragraphs}</body></html>`,
      );
    }
  }
  return async (url) => {
    const page = pages.get(url);
    if (page === undefined) return new Response("not found", { status: 404 });
    return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

const DAY_MS = 86_400_000;

/**
 * An activity whose course sets it due more days after install than the class's term has left (a
 * semester course added part way through the term) is due when the term ends instead, as an
 * activity with no due date is: the curriculum refuses a due date after the term.
 */
function withinTerm(activity: TemplateInput, termEndsOn: string | undefined, now: string): TemplateInput {
  const { due } = activity;
  if (termEndsOn === undefined || due.kind !== "after-install") return activity;
  const dueOn = new Date(Date.parse(now) + due.days * DAY_MS).toISOString().slice(0, 10);
  return dueOn > termEndsOn ? { ...activity, due: { kind: "none" } } : activity;
}

/** The district services an install acts through, as the class's teacher, for one request. */
export interface CourseInstallServices {
  offering: OfferingScope;
  caller: Caller;
  snapshot: DistrictDirectorySnapshot;
  curriculum: CurriculumService;
  content: CourseContentService;
  /** A Content Studio whose fetch is {@link readingsFetch} for the plan. */
  studio: ContentStudio;
  assessment: AssessmentService;
  /** Signs and stores a rubric release for the class, after checking the caller may. */
  signRubric(draft: RubricDraft): Promise<RubricRef>;
  /** Whether the district's approved standards hold a competency. */
  isApproved(frameworkKey: string, competencyUri: string): Promise<boolean>;
  store: CourseLibraryStore;
  now: () => string;
}

const emptyInstalls = (offeringId: string): OfferingCourseInstalls => ({ offeringId, revision: 0, definitions: [], courses: [] });

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The status of each unit of `plan` in a class: its progress record, else a module of the same title the class already has. */
function unitStatus(plan: CourseInstallPlan, outline: CourseOutline, course: InstalledCourse | undefined): Map<string, { status: CourseInstallUnitBody["status"]; moduleId?: string; progress?: InstalledUnit }> {
  const status = new Map<string, { status: CourseInstallUnitBody["status"]; moduleId?: string; progress?: InstalledUnit }>();
  // Modules this course made in the class are its own units, never a reason to skip one.
  const own = new Set(course?.units.flatMap((unit) => (unit.moduleId === undefined || unit.status === "exists" ? [] : [unit.moduleId])) ?? []);
  for (const unit of plan.units) {
    const progress = course?.units.find((u) => u.unitKey === unit.key);
    if (progress !== undefined) {
      status.set(unit.key, { status: progress.status, ...(progress.moduleId === undefined ? {} : { moduleId: progress.moduleId }), progress });
      continue;
    }
    const existing = outline.modules.find((module) => !own.has(module.id) && sameTitle(module.title, unit.title));
    status.set(unit.key, existing === undefined ? { status: "new" } : { status: "exists", moduleId: existing.id });
  }
  return status;
}

/** The export alignments of the units still to install, each once. */
function alignmentsToInstall(plan: CourseInstallPlan, pending: ReadonlySet<string>): { frameworkKey: string; competencyUri: string }[] {
  const imports = new Map(plan.imports.map((planned) => [planned.key, planned]));
  const seen = new Map<string, { frameworkKey: string; competencyUri: string }>();
  for (const unit of plan.units) {
    if (!pending.has(unit.key)) continue;
    for (const item of unit.items) {
      if (item.kind !== "activity" || item.definition.kind !== "portable") continue;
      for (const alignment of imports.get(item.definition.importKey)?.export.alignments ?? []) {
        seen.set(`${alignment.frameworkKey} ${alignment.competencyUri}`, { frameworkKey: alignment.frameworkKey, competencyUri: alignment.competencyUri });
      }
    }
  }
  return [...seen.values()];
}

/** Why the district cannot install these alignments yet: those its approved standards do not hold, named by code. */
async function standardsProblems(services: CourseInstallServices, alignments: readonly { frameworkKey: string; competencyUri: string }[]): Promise<string[]> {
  const missing: { frameworkKey: string; code: string }[] = [];
  for (const { frameworkKey, competencyUri } of alignments) {
    if (!(await services.isApproved(frameworkKey, competencyUri))) missing.push({ frameworkKey, code: standardsBody([{ frameworkKey, competencyUri }])[0]!.code });
  }
  if (missing.length === 0) return [];
  const frameworks = [...new Set(missing.map((m) => m.frameworkKey))];
  return frameworks.map((framework) => {
    const codes = missing.filter((m) => m.frameworkKey === framework).map((m) => m.code);
    return `The course's activities align to ${framework} learning goals your district has not approved (${codes.slice(0, 8).join(", ")}${codes.length > 8 ? ", …" : ""}). Ask a district administrator to approve the ${framework} standards.`;
  });
}

/** The plan as the class's teacher sees it, with what the class already has. */
async function planBody(services: CourseInstallServices, plan: CourseInstallPlan, installs: OfferingCourseInstalls, outline: CourseOutline): Promise<CourseInstallPlanBody> {
  const course = installs.courses.find((c) => c.packageId === plan.course.packageId && c.version === plan.course.version);
  const statuses = unitStatus(plan, outline, course);
  const templates = new Map(plan.imports.map((planned) => [planned.key, planned.export.activity.template]));
  const pending = new Set(plan.units.filter((unit) => ["new", "installing"].includes(statuses.get(unit.key)!.status)).map((unit) => unit.key));
  const all = new Set(plan.units.flatMap((unit) => unit.items.flatMap((item) => (item.kind === "activity" && item.definition.kind === "portable" ? [item.definition.importKey] : []))));
  const approved = await Promise.all(plan.course.standards.map(async (s) => services.isApproved(s.frameworkKey, s.competencyUri)));
  return {
    offeringId: services.offering.offeringId,
    packageId: plan.course.packageId,
    version: plan.course.version,
    title: plan.course.title,
    standards: standardsBody(plan.course.standards).map((s, i) => ({ ...s, approved: approved[i]! })),
    units: plan.units.map((unit): CourseInstallUnitBody => {
      const { status, moduleId, progress } = statuses.get(unit.key)!;
      return {
        key: unit.key,
        title: unit.title,
        ...(unit.summary === undefined ? {} : { summary: unit.summary }),
        status,
        ...(moduleId === undefined ? {} : { moduleId }),
        standards: standardsBody(unit.standards),
        items: unit.items.map((item) => {
          const done = progress?.items[item.key];
          const base = { key: item.key, title: item.title, kind: item.kind, done: done !== undefined && (item.kind !== "activity" || done.placed === true) };
          if (item.kind === "activity") {
            const template = item.definition.kind === "portable" ? templates.get(item.definition.importKey) : undefined;
            return { ...base, role: item.role, ...(template === undefined ? {} : { template }) };
          }
          return item.kind === "teacher-note" ? { ...base, purpose: item.purpose } : base;
        }),
      };
    }),
    reusedDefinitions: installs.definitions.filter((d) => all.has(d.key)).length,
    problems: await standardsProblems(services, alignmentsToInstall(plan, pending)),
    done: pending.size === 0,
  };
}

/** The class's outline as its staff see it. Only someone who may read the class's draft content may preview or install. */
async function staffOutline(services: CourseInstallServices): Promise<CourseOutline> {
  const view = await services.content.outline(services.caller.principal, services.offering.offeringId);
  if (view.view !== "teacher") throw new EducateOsError("forbidden", "Only the class's teachers can install a course in it.");
  return view.outline;
}

/**
 * What installing a library course in the class would do, given what it already has. Nothing is
 * stored.
 *
 * @throws EducateOsError `forbidden` unless the caller may read the class's draft content.
 */
export async function previewCourseInstall(services: CourseInstallServices, plan: CourseInstallPlan): Promise<CourseInstallPlanBody> {
  const outline = await staffOutline(services);
  const installs = (await services.store.loadInstalls(services.offering.offeringId)) ?? emptyInstalls(services.offering.offeringId);
  return planBody(services, plan, installs, outline);
}

/**
 * The district's {@link CourseInstallTarget} for one class and one course: every call goes through
 * the district's services as the teacher, and every step is recorded in the class's install record
 * as soon as it is done, so a later request resumes rather than repeats.
 */
class DistrictCourseInstallTarget implements CourseInstallTarget {
  readonly #services: CourseInstallServices;
  readonly #plan: CourseInstallPlan;
  #installs: OfferingCourseInstalls;
  readonly #courseIndex: number;

  constructor(services: CourseInstallServices, plan: CourseInstallPlan, installs: OfferingCourseInstalls, courseIndex: number) {
    this.#services = services;
    this.#plan = plan;
    this.#installs = installs;
    this.#courseIndex = courseIndex;
  }

  get installs(): OfferingCourseInstalls {
    return this.#installs;
  }

  get #course(): InstalledCourse {
    return this.#installs.courses[this.#courseIndex]!;
  }

  get #subject() {
    return this.#services.caller.principal;
  }

  /** The last day of the class's term. */
  get #termEndsOn(): string | undefined {
    const { snapshot, offering } = this.#services;
    const termId = snapshot.offerings.find((o) => o.id === offering.offeringId)?.termId;
    return snapshot.terms.find((t) => t.id === termId)?.endsOn;
  }

  /** Commits the record over the revision it was read at. */
  async save(): Promise<void> {
    const next = { ...this.#installs, revision: this.#installs.revision + 1 };
    await this.#services.store.commitInstalls(next, this.#installs.revision);
    this.#installs = next;
  }

  #unit(unitKey: string): InstalledUnit {
    let unit = this.#course.units.find((u) => u.unitKey === unitKey);
    if (unit === undefined) {
      unit = { unitKey, status: "installing", items: {} };
      this.#course.units.push(unit);
    }
    return unit;
  }

  #unitOfModule(moduleId: string): InstalledUnit {
    const unit = this.#course.units.find((u) => u.moduleId === moduleId);
    if (unit === undefined) throw new EducateOsError("conflict", "The course install lost track of a module; try again.");
    return unit;
  }

  async importDraft(item: PlannedImport): Promise<DistrictDefinitionRef> {
    const { offering } = this.#services;
    const exported = item.export;
    // Each reading becomes a release of the district's own, approved for this class by its teacher.
    const readings = new Map<string, ResourceReleaseRef>();
    for (const reading of exported.readings) {
      const submitted = await this.#services.studio.submitUrl(this.#subject, { url: readingUrl(exported.id, exported.version, reading.id), targetScope: offering });
      const release = await this.#services.studio.approve(this.#subject, submitted.id, { alignments: [] });
      readings.set(reading.id, { resourceId: release.descriptor.id, version: release.descriptor.release.version } as ResourceReleaseRef);
    }
    // The export's rubric, as data, becomes a rubric release of the district's own: no checks, since an export carries none.
    const rubric = exported.rubric === undefined ? undefined : await this.#services.signRubric({
      rubricId: RubricId.parse(`rbr_${randomIdBody()}`),
      version: 1,
      title: exported.rubric.title,
      criteria: exported.rubric.criteria.map((criterion) => ({
        id: criterion.id,
        title: criterion.title,
        ...(criterion.description === undefined ? {} : { description: criterion.description }),
        levels: criterion.levels.map((level) => ({ ...level })),
        checks: [],
      })),
    } as RubricDraft);
    const activity = withinTerm(templateInputFor(exported, { readings, rubric }), this.#termEndsOn, this.#services.now());
    const draft = await this.#services.curriculum.createDraft(this.#subject, { scope: offering, activity });
    const definition = { definitionId: draft.id, version: draft.version };
    this.#installs.definitions.push({
      key: item.key,
      ref: { ...item.ref },
      definition,
      status: "draft",
      ...(rubric === undefined ? {} : { rubric: { rubricId: rubric.rubricId, version: rubric.version } }),
      readings: Object.fromEntries([...readings].map(([id, ref]) => [id, { resourceId: ref.resourceId, version: ref.version }])),
    });
    await this.save();
    return DistrictDefinitionRef.parse(definition);
  }

  async publish(draft: DistrictDefinitionRef): Promise<DistrictDefinitionRef> {
    // The teacher's install is the review: their explicit choice to install the course publishes its drafts for the class.
    const published = await this.#services.curriculum.publish(this.#subject, draft.definitionId);
    for (const definition of this.#installs.definitions) {
      if (definition.definition.definitionId === draft.definitionId) Object.assign(definition, { status: "published", definition: { definitionId: published.id, version: published.version } });
    }
    await this.save();
    return DistrictDefinitionRef.parse({ definitionId: published.id, version: published.version });
  }

  async createModule(unit: PlannedUnit): Promise<{ moduleId: string }> {
    const progress = this.#unit(unit.key);
    if (progress.moduleId !== undefined) {
      const outline = (await this.#services.content.outline(this.#subject, this.#services.offering.offeringId)).outline;
      if (outline.modules.some((m) => m.id === progress.moduleId)) return { moduleId: progress.moduleId };
      // Its module was removed since: the unit starts again in a new one.
      progress.items = {};
    }
    const { packageId, version } = this.#plan.course;
    const module = await this.#services.content.createModule(this.#subject, this.#services.offering.offeringId, { title: unit.title }, {
      kind: "course",
      packageId,
      version,
      packageDigest: this.#course.digest,
      unitKey: unit.key,
    });
    progress.moduleId = module.id;
    progress.status = "installing";
    await this.save();
    return { moduleId: module.id };
  }

  async addPage(moduleId: string, page: PlannedPage): Promise<void> {
    const unit = this.#unitOfModule(moduleId);
    if (unit.items[page.key] !== undefined) return;
    await this.#services.content.addPage(this.#subject, this.#services.offering.offeringId, moduleId, { title: page.title, body: page.body });
    unit.items[page.key] = {};
    await this.save();
  }

  async addTeacherNote(moduleId: string, note: PlannedTeacherNote): Promise<void> {
    const unit = this.#unitOfModule(moduleId);
    if (unit.items[note.key] !== undefined) return;
    await this.#services.content.addTeacherNote(this.#subject, this.#services.offering.offeringId, moduleId, { title: note.title, body: note.body, purpose: note.purpose });
    unit.items[note.key] = {};
    await this.save();
  }

  async addResource(moduleId: string, item: PlannedResource): Promise<void> {
    // A course's resources are Content Studio releases of the district that wrote it, which mean
    // nothing here (RFC 0001 §13.1); a module has no place for one. Recorded as handled, not placed.
    const unit = this.#unitOfModule(moduleId);
    if (unit.items[item.key] !== undefined) return;
    unit.items[item.key] = {};
    await this.save();
  }

  async install(moduleId: string, definition: DistrictDefinitionRef, item: PlannedActivity): Promise<{ activityId: string }> {
    const unit = this.#unitOfModule(moduleId);
    const { offering } = this.#services;
    let record = unit.items[item.key];
    if (record?.activityId === undefined) {
      const rubric = this.#installs.definitions.find((d) => d.definition.definitionId === definition.definitionId)?.rubric;
      const { installation, assignment } = await installAndAssign({
        curriculum: this.#services.curriculum,
        assessment: this.#services.assessment,
        caller: this.#services.caller,
        snapshot: this.#services.snapshot,
        definitionId: ActivityDefinitionId.parse(definition.definitionId),
        version: definition.version,
        offering,
        settings: AssignmentSettingsInput.parse(rubric === undefined ? {} : { rubric }),
      });
      record = { activityId: installation.id, assignmentId: assignment.id, placed: false };
      unit.items[item.key] = record;
      await this.save();
    }
    if (record.placed !== true) {
      try {
        await this.#services.content.placeActivity(this.#subject, offering.offeringId, moduleId, { activityId: record.activityId });
      } catch (error) {
        // Placed by a request that stopped before it could say so.
        if (!(error instanceof EducateOsError && error.code === "conflict")) throw error;
      }
      record.placed = true;
      await this.save();
    }
    return { activityId: record.activityId! };
  }
}

/**
 * Installs a library course in the class, or the next `maxUnits` of its units still to install,
 * resuming whatever an earlier request began. Units the class already has a module of the same
 * title for are skipped and recorded as such. Before anything is written, the units to install are
 * checked against the district's approved standards, so a course that cannot install changes
 * nothing.
 *
 * @throws EducateOsError `forbidden` unless the caller may author the class's content,
 *   `validation-failed` if an activity aligns to a standard the district has not approved, and
 *   whatever the district's services refuse; what was done before a refusal stays done, and the
 *   next request resumes after it.
 */
export async function installCourse(services: CourseInstallServices, plan: CourseInstallPlan, options: { maxUnits?: number | undefined; digest: string }): Promise<CourseInstallPlanBody> {
  const outline = await staffOutline(services);
  const offeringId = services.offering.offeringId;
  const installs = (await services.store.loadInstalls(offeringId)) ?? emptyInstalls(offeringId);
  let courseIndex = installs.courses.findIndex((c) => c.packageId === plan.course.packageId && c.version === plan.course.version);
  if (courseIndex === -1) {
    installs.courses.push({ packageId: plan.course.packageId, version: plan.course.version, digest: options.digest, reviewedBy: services.caller.principal.principalId, reviewedAt: services.now(), units: [] });
    courseIndex = installs.courses.length - 1;
  }
  const course = installs.courses[courseIndex]!;
  const statuses = unitStatus(plan, outline, course);
  const batch = new Set<string>();
  for (const unit of plan.units) {
    const { status, moduleId } = statuses.get(unit.key)!;
    if (status === "exists" && !course.units.some((u) => u.unitKey === unit.key)) course.units.push({ unitKey: unit.key, status: "exists", ...(moduleId === undefined ? {} : { moduleId }), items: {} });
    if ((status === "new" || status === "installing") && batch.size < (options.maxUnits ?? Infinity)) batch.add(unit.key);
  }
  const problems = await standardsProblems(services, alignmentsToInstall(plan, batch));
  if (problems.length > 0) throw new EducateOsError("validation-failed", problems.join(" "));

  const target = new DistrictCourseInstallTarget(services, plan, installs, courseIndex);
  await target.save();
  const mappings: InstallMapping[] = target.installs.definitions.map(({ key, ref, definition, status }) => ({
    key,
    ref: ref as InstallMapping["ref"],
    definition: DistrictDefinitionRef.parse(definition),
    status,
  }));
  await applyInstallPlan(plan, target, { mappings, publishDrafts: true, skipUnit: (unit) => !batch.has(unit.key) });

  const finished = target.installs.courses[courseIndex]!;
  for (const unit of finished.units) if (batch.has(unit.unitKey)) unit.status = "installed";
  const remaining = plan.units.some((unit) => {
    const progress = finished.units.find((u) => u.unitKey === unit.key);
    return progress === undefined || progress.status === "installing";
  });
  if (!remaining && finished.completedAt === undefined) finished.completedAt = services.now();
  await target.save();
  const after = (await services.content.outline(services.caller.principal, offeringId)).outline;
  return planBody(services, plan, target.installs, after);
}
