// Course authoring adapters (SCHO-186): a Common Cartridge to and from an offering's modules. The
// course content service decides and records; these only translate, checking every item against
// the same schemas a teacher's own page or link must pass, so a preview shows exactly what an
// import would store.
import { EducateOsError, type VerifiedPrincipal } from "@educateos/contracts";
import {
  courseCartridgePackage,
  DEFAULT_CARTRIDGE_LIMITS,
  planCourseCartridge,
  readCartridge,
  type CourseCartridgeExport,
  type CourseCartridgePlan,
} from "@educateos/cartridge";
import { ContentTitle, ModuleLinkUrl, PageMarkdown, type CourseContentService, type CourseModule, type CourseOutline, type ImportedModule } from "@educateos/curriculum";
import { DiscussionMarkdown, type DiscussionService, type DiscussionTopic } from "@educateos/discussions";
// Quizzes (SCHO-191)
import { QuizItemDraft, type Quiz, type QuizService } from "@educateos/quizzes";
import { MAX_CARTRIDGE_UPLOAD_BYTES, type CartridgeExportBody, type CartridgePreviewBody } from "./routes.ts";

/**
 * A cartridge read and mapped to modules, with every item it can store and every one it cannot,
 * and the discussion topics each module carries (SCHO-190), by the module's index in `modules`.
 */
interface CheckedCartridge {
  modules: ImportedModule[];
  discussions: { module: number; identifier: string; title: string; prompt: string }[];
  /** The QTI quizzes each module carries (SCHO-191), each item checked as a teacher's own would be. */
  quizzes: { module: number; identifier: string; title: string; items: QuizItemDraft[] }[];
  preview: CartridgePreviewBody;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Keeps the items a teacher could have written themselves, listing the rest as skipped. */
function check(plan: CourseCartridgePlan): CheckedCartridge {
  const skipped: CartridgePreviewBody["skipped"] = plan.skipped.map((skip) => ({ ...skip }));
  const modules: ImportedModule[] = [];
  const discussions: CheckedCartridge["discussions"] = [];
  const quizzes: CheckedCartridge["quizzes"] = [];
  for (const module of plan.modules) {
    const items = module.items.filter((item) => {
      const ok = ContentTitle.safeParse(item.title).success
        && (item.kind === "page" ? PageMarkdown.safeParse(item.body).success : ModuleLinkUrl.safeParse(item.url).success);
      if (!ok) skipped.push({ identifier: item.identifier, reason: "not-acceptable" });
      return ok;
    });
    // Discussions (SCHO-190): a topic is checked as a teacher's own topic would be.
    const topics = module.discussions.filter((topic) => {
      const ok = ContentTitle.safeParse(topic.title).success && DiscussionMarkdown.safeParse(topic.prompt).success;
      if (!ok) skipped.push({ identifier: topic.identifier, reason: "not-acceptable" });
      return ok;
    });
    // Quizzes (SCHO-191): each item is checked as a teacher's own item would be; a quiz with none left is skipped.
    const moduleQuizzes = module.quizzes.flatMap((quiz) => {
      const items = quiz.items.flatMap((item, index) => {
        const parsed = QuizItemDraft.safeParse(item);
        if (!parsed.success) skipped.push({ identifier: `${quiz.identifier}/${index + 1}`, reason: "not-acceptable" });
        return parsed.success ? [parsed.data] : [];
      });
      const title = ContentTitle.safeParse(quiz.title).success ? quiz.title : "Imported quiz";
      if (items.length === 0) skipped.push({ identifier: quiz.identifier, reason: "not-acceptable" });
      return items.length === 0 ? [] : [{ identifier: quiz.identifier, title, items }];
    });
    if (items.length === 0 && topics.length === 0 && moduleQuizzes.length === 0) continue;
    for (const topic of topics) discussions.push({ module: modules.length, identifier: topic.identifier, title: topic.title, prompt: topic.prompt });
    for (const quiz of moduleQuizzes) quizzes.push({ module: modules.length, ...quiz });
    const title = ContentTitle.safeParse(module.title).success ? module.title : "Imported module";
    modules.push({ title, items: items.map((item) => (item.kind === "page" ? { kind: "page", title: item.title, body: item.body } : { kind: "link", title: item.title, url: item.url })) });
  }
  return {
    modules,
    discussions,
    quizzes,
    preview: {
      packageDigest: plan.packageDigest,
      title: plan.title,
      modules: modules.map((module, index) => {
        const topics = discussions.filter((topic) => topic.module === index).map((topic) => ({ title: topic.title, characters: topic.prompt.length }));
        const moduleQuizzes = quizzes.filter((quiz) => quiz.module === index).map((quiz) => ({ title: quiz.title, questions: quiz.items.length }));
        return {
          title: module.title,
          items: module.items.map((item) => (item.kind === "page" ? { kind: "page", title: item.title, characters: item.body.length } : { kind: "link", title: item.title, url: item.url })),
          ...(topics.length === 0 ? {} : { discussions: topics }),
          ...(moduleQuizzes.length === 0 ? {} : { quizzes: moduleQuizzes }),
        };
      }),
      skipped,
      flattened: plan.flattened,
      truncated: plan.truncated,
    },
  };
}

/** Reads an uploaded package within the upload limit and maps it to modules. Nothing is stored. */
async function readUpload(base64: string): Promise<CheckedCartridge> {
  const bytes = decodeBase64(base64);
  const limits = { ...DEFAULT_CARTRIDGE_LIMITS, maxPackageBytes: MAX_CARTRIDGE_UPLOAD_BYTES };
  return check(planCourseCartridge(await readCartridge(bytes, limits)));
}

/**
 * What importing a cartridge into an offering would add. The caller must be allowed to read the
 * offering's content as staff, so a preview reveals nothing to anyone who could not import.
 */
export async function previewCourseCartridge(content: CourseContentService, subject: VerifiedPrincipal, offeringId: string, base64: string): Promise<CartridgePreviewBody> {
  if ((await content.outline(subject, offeringId)).view !== "teacher") throw new EducateOsError("forbidden", "Only the class's teachers can import into it.");
  return (await readUpload(base64)).preview;
}

/**
 * Imports a previewed cartridge into an offering as unpublished modules.
 *
 * @throws EducateOsError `conflict` if the package is not the one previewed, and
 *   `validation-failed` if it holds nothing a module can store.
 */
export async function importCourseCartridge(
  content: CourseContentService,
  subject: VerifiedPrincipal,
  input: { offeringId: string; fileName: string; base64: string; packageDigest: string },
  discussions?: DiscussionService,
  quizService?: QuizService,
): Promise<{ modules: CourseModule[]; topics: DiscussionTopic[]; quizzes: Quiz[]; preview: CartridgePreviewBody }> {
  const checked = await readUpload(input.base64);
  if (checked.preview.packageDigest !== input.packageDigest) throw new EducateOsError("conflict", "This is not the package you previewed; preview it again.");
  if (checked.modules.length === 0) throw new EducateOsError("validation-failed", "The package holds no pages or links a module can store.");
  const modules = await content.importModules(subject, input.offeringId, checked.modules, {
    kind: "cartridge",
    fileName: input.fileName,
    packageDigest: checked.preview.packageDigest,
  });
  // Discussions (SCHO-190): each topic goes into the module it came with, which starts as a draft,
  // so students see the topics once the teacher publishes the module.
  const topics = discussions === undefined || checked.discussions.length === 0 ? [] : await discussions.importTopics(subject, input.offeringId, checked.discussions.map((topic) => ({
    moduleId: modules[topic.module]!.id,
    title: topic.title,
    prompt: topic.prompt,
    source: { kind: "cartridge", fileName: input.fileName, packageDigest: checked.preview.packageDigest, identifier: topic.identifier },
  })));
  // Quizzes (SCHO-191): each goes into its module as a draft, for the teacher to bind to an
  // assignment and publish.
  const quizzes = quizService === undefined || checked.quizzes.length === 0 ? [] : await quizService.importQuizzes(subject, input.offeringId, checked.quizzes.map((quiz) => ({
    moduleId: modules[quiz.module]!.id,
    title: quiz.title,
    items: quiz.items,
    source: { kind: "cartridge" as const, fileName: input.fileName, packageDigest: checked.preview.packageDigest, identifier: quiz.identifier },
  })));
  return { modules, topics, quizzes, preview: checked.preview };
}

/**
 * Exports an offering's modules (drafts included: only staff can export) as a Common Cartridge
 * 1.3 package. Activities are EducateOS assignments a cartridge cannot carry, and quizzes are not
 * written as QTI yet (SCHO-191); each is listed.
 */
export async function exportCourseCartridge(
  outline: CourseOutline,
  courseTitle: string,
  sectionName: string,
  topics: readonly DiscussionTopic[] = [],
  quizzes: readonly Quiz[] = [],
): Promise<CartridgeExportBody> {
  const pages = new Map(outline.pages.map((page) => [page.id, page]));
  const losses: CartridgeExportBody["losses"] = [];
  for (const quiz of quizzes) {
    if (quiz.moduleId !== undefined && outline.modules.some((m) => m.id === quiz.moduleId)) losses.push({ kind: "quiz", module: quiz.moduleId, item: quiz.id });
  }
  const course: CourseCartridgeExport = {
    title: `${courseTitle} (${sectionName})`,
    language: "en",
    modules: outline.modules.map((module) => ({
      title: module.title,
      items: module.items.flatMap((item): CourseCartridgeExport["modules"][number]["items"][number][] => {
        if (item.kind === "activity") {
          losses.push({ kind: "activity", module: module.id, item: item.id });
          return [];
        }
        if (item.kind === "link") return [{ kind: "link", title: item.title, url: item.url }];
        const page = pages.get(item.pageId)!;
        return [{ kind: "page", title: page.title, body: page.body }];
      }),
      // Discussions (SCHO-190): the topics placed in the module travel with it; their posts do not.
      discussions: topics.filter((topic) => topic.moduleId === module.id).map((topic) => ({ title: topic.title, prompt: topic.prompt })),
    })),
  };
  const slug = `${courseTitle}-${sectionName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "course";
  return { fileName: `${slug}.imscc`, base64: encodeBase64(await courseCartridgePackage(course)), losses };
}
