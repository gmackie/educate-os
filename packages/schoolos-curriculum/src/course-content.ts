// An offering's authored course content (SCHO-186): ordered modules holding pages, installed
// activities and links. It is what a class with no LMS is taught from, and what a Common Cartridge
// is imported into and exported from. Every call is decided by the district's policy engine as a
// `course-content` resource at the offering: a draft module is `teacher-only`, a published one
// `course` material.
import { checkImportUrl, randomIdBody } from "@schoolos/content-studio";
import {
  type Action,
  ActivityId,
  type AuthorizationRequest,
  type Authorizer,
  type Classification,
  type DistrictDirectorySnapshot,
  type DistrictId,
  OfferingId,
  PrincipalId,
  type RequestChannel,
  SchoolOsError,
  type VerifiedPrincipal,
} from "@schoolos/contracts";
import { z } from "zod";
import type { OfferingScope } from "./ids.ts";
import type { CurriculumStorage } from "./storage.ts";

/** Identifies a course module. */
export const CourseModuleId = z.string().regex(/^cmod_[a-z0-9]{1,64}$/, "expected a course module ID");
/** A course module identifier. */
export type CourseModuleId = z.infer<typeof CourseModuleId>;

/** Identifies a course page. */
export const CoursePageId = z.string().regex(/^cpg_[a-z0-9]{1,64}$/, "expected a course page ID");
/** A course page identifier. */
export type CoursePageId = z.infer<typeof CoursePageId>;

/** Identifies one placement within a module. */
export const ModuleItemId = z.string().regex(/^cit_[a-z0-9]{1,64}$/, "expected a module item ID");
/** A module item identifier. */
export type ModuleItemId = z.infer<typeof ModuleItemId>;

// Markup that runs or loads code when rendered. Pages are Markdown, rendered as text with a small
// fixed set of formatting; refusing these as well means a renderer that slips cannot be turned into
// a script host. The same rule as OCS package text.
const ACTIVE_CONTENT = /<\s*\/?\s*(script|iframe|object|embed|applet|style|link|meta|base|form|svg)\b|\b(javascript|vbscript)\s*:|data\s*:\s*text\/html/i;

/** The most characters a page's Markdown may hold. */
export const MAX_PAGE_LENGTH = 20_000;

/** A title: plain text, at most 200 characters. */
export const ContentTitle = z.string().trim().min(1).max(200).refine((text) => !ACTIVE_CONTENT.test(text), "a title may not contain active markup");

/**
 * A page's body: Markdown, rendered by the SchoolOS UIs as text with headings, lists, emphasis and
 * `https` links only, never as HTML. Markup that could run code is refused outright.
 */
export const PageMarkdown = z.string().max(MAX_PAGE_LENGTH).refine((text) => !ACTIVE_CONTENT.test(text), "a page may not contain scripts or active markup");

/** An `https` link a module may hold: one the Content Studio's import checks would accept. */
export const ModuleLinkUrl = z.string().max(2048).refine((url) => checkImportUrl(url).ok, "expected a public https URL");

/** A page of course content. */
export const CoursePage = z.strictObject({
  id: CoursePageId,
  title: ContentTitle,
  body: PageMarkdown,
});
/** A page. */
export type CoursePage = z.infer<typeof CoursePage>;

/** One placement in a module: a page, an activity installed in the offering, or an external link. */
export const ModuleItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page"), id: ModuleItemId, pageId: CoursePageId }),
  z.strictObject({ kind: z.literal("activity"), id: ModuleItemId, activityId: ActivityId }),
  z.strictObject({ kind: z.literal("link"), id: ModuleItemId, title: ContentTitle, url: ModuleLinkUrl }),
]);
/** A module item. */
export type ModuleItem = z.infer<typeof ModuleItem>;

/** Where a module came from, when it was not authored in SchoolOS. */
export const ModuleSource = z.strictObject({
  kind: z.literal("cartridge"),
  fileName: z.string().min(1).max(255),
  packageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
/** A module source. */
export type ModuleSource = z.infer<typeof ModuleSource>;

/** A module: an ordered, titled group of items that is published to students as a whole. */
export const CourseModule = z.strictObject({
  id: CourseModuleId,
  title: ContentTitle,
  published: z.boolean(),
  items: z.array(ModuleItem).max(100),
  source: ModuleSource.optional(),
});
/** A module. */
export type CourseModule = z.infer<typeof CourseModule>;

/** One offering's course content: its modules in order, and the pages they place. */
export const CourseOutline = z.strictObject({
  offeringId: OfferingId,
  /** 0 before anything is stored; each commit adds one. */
  revision: z.int().nonnegative(),
  modules: z.array(CourseModule).max(100),
  pages: z.array(CoursePage).max(2000),
  updated: z.strictObject({ by: PrincipalId, at: z.iso.datetime({ offset: true }) }).optional(),
});
/** A course outline. */
export type CourseOutline = z.infer<typeof CourseOutline>;

/** What one reader may see of an outline: staff see drafts; students only published modules and their pages. */
export interface CourseOutlineView {
  view: "teacher" | "student";
  outline: CourseOutline;
}

/**
 * Where each offering's course content is kept. A commit replaces the offering's outline only if
 * its revision is still the one the change was made against.
 */
export interface CourseContentStorage {
  /** The offering's outline, or undefined if nothing has been stored for it. */
  load(offeringId: OfferingId): Promise<CourseOutline | undefined>;
  /**
   * Stores `outline` (whose revision is one more than `expectedRevision`).
   *
   * @throws SchoolOsError `conflict` if the stored revision is not `expectedRevision`.
   */
  commit(outline: CourseOutline, expectedRevision: number): Promise<void>;
}

/** {@link CourseContentStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryCourseContentStorage implements CourseContentStorage {
  readonly #outlines = new Map<string, CourseOutline>();

  async load(offeringId: OfferingId): Promise<CourseOutline | undefined> {
    const outline = this.#outlines.get(offeringId);
    return outline === undefined ? undefined : structuredClone(outline);
  }

  async commit(outline: CourseOutline, expectedRevision: number): Promise<void> {
    const parsed = CourseOutline.parse(outline);
    if ((this.#outlines.get(parsed.offeringId)?.revision ?? 0) !== expectedRevision) {
      throw new SchoolOsError("conflict", "The course content changed while this request was in progress; reload it and try again.");
    }
    this.#outlines.set(parsed.offeringId, structuredClone(parsed));
  }
}

/** A module brought in from elsewhere, such as a Common Cartridge: its title and items, in order. */
export interface ImportedModule {
  title: string;
  items: ({ kind: "page"; title: string; body: string } | { kind: "link"; title: string; url: string })[];
}

/** A change to a module's title or publication. */
export const ModulePatch = z.strictObject({ title: ContentTitle.optional(), published: z.boolean().optional() });
/** A module change. */
export type ModulePatch = z.infer<typeof ModulePatch>;

/** A new page. */
export const NewPage = z.strictObject({ title: ContentTitle, body: PageMarkdown });
/** A new page. */
export type NewPage = z.infer<typeof NewPage>;

/** A change to a page. */
export const PagePatch = NewPage.partial();
/** A page change. */
export type PagePatch = z.infer<typeof PagePatch>;

/** Everything a course content service needs. Each district runs its own. */
export interface CourseContentServiceOptions {
  districtId: DistrictId;
  /** The district directory, for offerings and their terms. */
  directory: DistrictDirectorySnapshot;
  /** Decides every call: the district's `PolicyEngine`, with its `course-content` rules. */
  authorizer: Authorizer;
  channel?: RequestChannel;
  storage: CourseContentStorage;
  /** The curriculum's installations, so a module places only activities installed in its offering. */
  installations: Pick<CurriculumStorage, "getInstallation">;
  /** The current time as an ISO 8601 timestamp. */
  now?: () => string;
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new SchoolOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

const NOT_FOUND = () => new SchoolOsError("not-found", "no such course content");
const newId = <P extends string>(prefix: P) => `${prefix}_${randomIdBody()}` as const;

/** `ids` must name every member of `current` exactly once. */
function reordered<T extends { id: string }>(current: readonly T[], ids: readonly string[], what: string): T[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) {
    throw new SchoolOsError("validation-failed", `the new order must list every ${what} exactly once`);
  }
  return ids.map((id) => byId.get(id)!);
}

/**
 * Teachers' course content for one district (SCHO-186): modules in order, each holding pages,
 * activities installed in the offering, and links, published to the offering's students one
 * module at a time. Its staff author it; its actively enrolled students read the published
 * modules; administrators over it read it all. A completed term's content is read-only.
 */
export class CourseContentService {
  readonly #options: CourseContentServiceOptions;
  readonly #now: () => string;

  constructor(options: CourseContentServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * The offering's outline as the subject may see it: in full for staff and administrators,
   * published modules and their pages only for students.
   *
   * @throws SchoolOsError `not-found` if the subject may see none of it.
   */
  async outline(subject: VerifiedPrincipal, offeringId: unknown): Promise<CourseOutlineView> {
    const scope = this.#scope(offeringId);
    const outline = await this.#load(scope.offeringId);
    if (await this.#allowed(subject, "read", scope, "teacher-only")) return { view: "teacher", outline };
    if (!(await this.#allowed(subject, "read", scope, "course"))) throw NOT_FOUND();
    const modules = outline.modules.filter((module) => module.published);
    const pageIds = new Set(modules.flatMap((module) => module.items.flatMap((item) => (item.kind === "page" ? [item.pageId] : []))));
    const { updated: _, ...rest } = outline;
    return { view: "student", outline: { ...rest, modules, pages: outline.pages.filter((page) => pageIds.has(page.id)) } };
  }

  /** Adds an unpublished module at the end. */
  async createModule(subject: VerifiedPrincipal, offeringId: unknown, input: unknown): Promise<CourseModule> {
    const { title } = parseInput(z.strictObject({ title: ContentTitle }), input);
    const module: CourseModule = { id: newId("cmod"), title, published: false, items: [] };
    await this.#change(subject, offeringId, "create", (outline) => ({ ...outline, modules: [...outline.modules, module] }));
    return module;
  }

  /** Renames a module, or publishes or unpublishes it. Publishing either way is the `publish` action. */
  async updateModule(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown, input: unknown): Promise<CourseModule> {
    const patch = parseInput(ModulePatch, input);
    let updated: CourseModule | undefined;
    await this.#change(subject, offeringId, patch.published === undefined ? "update" : "publish", (outline) => {
      const module = this.#module(outline, moduleId);
      updated = { ...module, ...(patch.title === undefined ? {} : { title: patch.title }), ...(patch.published === undefined ? {} : { published: patch.published }) };
      return { ...outline, modules: outline.modules.map((m) => (m.id === module.id ? updated! : m)) };
    });
    return updated!;
  }

  /** Removes a module and the pages it placed. Activities it placed stay installed in the offering. */
  async deleteModule(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown): Promise<void> {
    await this.#change(subject, offeringId, "delete", (outline) => {
      const module = this.#module(outline, moduleId);
      const pages = new Set(module.items.flatMap((item) => (item.kind === "page" ? [item.pageId] : [])));
      return { ...outline, modules: outline.modules.filter((m) => m.id !== module.id), pages: outline.pages.filter((p) => !pages.has(p.id)) };
    });
  }

  /** Puts the modules in a new order, which must name every module once. */
  async reorderModules(subject: VerifiedPrincipal, offeringId: unknown, input: unknown): Promise<CourseOutline> {
    const { moduleIds } = parseInput(z.strictObject({ moduleIds: z.array(z.string()).max(100) }), input);
    return this.#change(subject, offeringId, "update", (outline) => ({ ...outline, modules: reordered(outline.modules, moduleIds, "module") }));
  }

  /** Adds a page at the end of a module. */
  async addPage(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown, input: unknown): Promise<{ page: CoursePage; item: ModuleItem }> {
    const { title, body } = parseInput(NewPage, input);
    const page: CoursePage = { id: newId("cpg"), title, body };
    const item: ModuleItem = { kind: "page", id: newId("cit"), pageId: page.id };
    await this.#change(subject, offeringId, "update", (outline) => {
      const module = this.#module(outline, moduleId);
      return { ...outline, modules: this.#replace(outline, { ...module, items: [...module.items, item] }), pages: [...outline.pages, page] };
    });
    return { page, item };
  }

  /** Changes a page's title or body. */
  async updatePage(subject: VerifiedPrincipal, offeringId: unknown, pageId: unknown, input: unknown): Promise<CoursePage> {
    const patch = parseInput(PagePatch, input);
    let updated: CoursePage | undefined;
    await this.#change(subject, offeringId, "update", (outline) => {
      const page = outline.pages.find((p) => p.id === pageId);
      if (page === undefined) throw NOT_FOUND();
      updated = { ...page, ...(patch.title === undefined ? {} : { title: patch.title }), ...(patch.body === undefined ? {} : { body: patch.body }) };
      return { ...outline, pages: outline.pages.map((p) => (p.id === page.id ? updated! : p)) };
    });
    return updated!;
  }

  /**
   * Places an activity installed in this offering at the end of a module. Students still reach it
   * only through its assignment; placing it changes no assignment.
   *
   * @throws SchoolOsError `validation-failed` for an activity not installed in this offering, and
   *   `conflict` if the module already places it.
   */
  async placeActivity(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown, input: unknown): Promise<ModuleItem> {
    const { activityId } = parseInput(z.strictObject({ activityId: ActivityId }), input);
    const scope = this.#scope(offeringId);
    const installation = await this.#options.installations.getInstallation(activityId);
    if (installation === undefined || installation.scope.offeringId !== scope.offeringId || installation.scope.districtId !== this.#options.districtId) {
      throw new SchoolOsError("validation-failed", "only an activity installed in this class can be placed in its modules");
    }
    const item: ModuleItem = { kind: "activity", id: newId("cit"), activityId };
    await this.#change(subject, scope.offeringId, "update", (outline) => {
      const module = this.#module(outline, moduleId);
      if (module.items.some((i) => i.kind === "activity" && i.activityId === activityId)) throw new SchoolOsError("conflict", "the module already places this activity");
      return { ...outline, modules: this.#replace(outline, { ...module, items: [...module.items, item] }) };
    });
    return item;
  }

  /** Removes an item from a module; a page it placed is removed with it. */
  async removeItem(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown, itemId: unknown): Promise<void> {
    await this.#change(subject, offeringId, "update", (outline) => {
      const module = this.#module(outline, moduleId);
      const item = module.items.find((i) => i.id === itemId);
      if (item === undefined) throw NOT_FOUND();
      return {
        ...outline,
        modules: this.#replace(outline, { ...module, items: module.items.filter((i) => i.id !== item.id) }),
        pages: item.kind === "page" ? outline.pages.filter((p) => p.id !== item.pageId) : outline.pages,
      };
    });
  }

  /** Puts a module's items in a new order, which must name every item once. */
  async reorderItems(subject: VerifiedPrincipal, offeringId: unknown, moduleId: unknown, input: unknown): Promise<CourseModule> {
    const { itemIds } = parseInput(z.strictObject({ itemIds: z.array(z.string()).max(100) }), input);
    let updated: CourseModule | undefined;
    await this.#change(subject, offeringId, "update", (outline) => {
      const module = this.#module(outline, moduleId);
      updated = { ...module, items: reordered(module.items, itemIds, "item") };
      return { ...outline, modules: this.#replace(outline, updated) };
    });
    return updated!;
  }

  /**
   * Appends imported modules, unpublished, so a teacher reviews them before students see them. Each
   * page and link is checked as if a teacher had written it; one that fails refuses the whole
   * import and nothing is stored.
   */
  async importModules(subject: VerifiedPrincipal, offeringId: unknown, modules: readonly ImportedModule[], source: ModuleSource): Promise<CourseModule[]> {
    const parsedSource = parseInput(ModuleSource, source);
    const pages: CoursePage[] = [];
    const created = modules.map((imported): CourseModule => ({
      id: newId("cmod"),
      title: parseInput(ContentTitle, imported.title),
      published: false,
      source: parsedSource,
      items: imported.items.map((item): ModuleItem => {
        if (item.kind === "link") return parseInput(ModuleItem, { kind: "link", id: newId("cit"), title: item.title, url: item.url });
        const page = parseInput(CoursePage, { id: newId("cpg"), title: item.title, body: item.body });
        pages.push(page);
        return { kind: "page", id: newId("cit"), pageId: page.id };
      }),
    }));
    await this.#change(subject, offeringId, "create", (outline) => ({ ...outline, modules: [...outline.modules, ...created], pages: [...outline.pages, ...pages] }));
    return created;
  }

  #module(outline: CourseOutline, moduleId: unknown): CourseModule {
    const module = outline.modules.find((m) => m.id === moduleId);
    if (module === undefined) throw NOT_FOUND();
    return module;
  }

  #replace(outline: CourseOutline, module: CourseModule): CourseModule[] {
    return outline.modules.map((m) => (m.id === module.id ? module : m));
  }

  /** Authorizes `action`, applies `change` to the stored outline and commits it over the revision it read. */
  async #change(subject: VerifiedPrincipal, offeringId: unknown, action: Action, change: (outline: CourseOutline) => CourseOutline): Promise<CourseOutline> {
    const scope = this.#scope(offeringId);
    if (!(await this.#allowed(subject, action, scope, "teacher-only"))) {
      if (await this.#allowed(subject, "read", scope, "course")) throw new SchoolOsError("forbidden", `not permitted to ${action} this class's content`);
      throw NOT_FOUND();
    }
    const current = await this.#load(scope.offeringId);
    const next = CourseOutline.parse({ ...change(current), revision: current.revision + 1, updated: { by: subject.principalId, at: this.#now() } });
    await this.#options.storage.commit(next, current.revision);
    return next;
  }

  async #load(offeringId: OfferingId): Promise<CourseOutline> {
    return (await this.#options.storage.load(offeringId)) ?? { offeringId, revision: 0, modules: [], pages: [] };
  }

  #scope(offeringId: unknown): OfferingScope {
    const id = OfferingId.safeParse(offeringId);
    const offering = id.success ? this.#options.directory.offerings.find((o) => o.id === id.data) : undefined;
    if (offering === undefined || offering.districtId !== this.#options.districtId) throw NOT_FOUND();
    return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
  }

  async #allowed(subject: VerifiedPrincipal, action: Action, scope: OfferingScope, classification: Classification): Promise<boolean> {
    const offering = this.#options.directory.offerings.find((o) => o.id === scope.offeringId);
    const termState = this.#options.directory.terms.find((t) => t.id === offering?.termId)?.state;
    const decision = await this.#options.authorizer.authorize({
      subject,
      action,
      resource: { kind: "course-content", scope, classification },
      context: { channel: this.#options.channel ?? "http", ...(termState === undefined ? {} : { termState }) },
    } satisfies AuthorizationRequest);
    return decision.effect === "allow";
  }
}
