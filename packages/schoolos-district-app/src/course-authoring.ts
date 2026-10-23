// Course authoring adapters (SCHO-186): a Common Cartridge to and from an offering's modules. The
// course content service decides and records; these only translate, checking every item against
// the same schemas a teacher's own page or link must pass, so a preview shows exactly what an
// import would store.
import { SchoolOsError, type VerifiedPrincipal } from "@schoolos/contracts";
import {
  courseCartridgePackage,
  DEFAULT_CARTRIDGE_LIMITS,
  planCourseCartridge,
  readCartridge,
  type CourseCartridgeExport,
  type CourseCartridgePlan,
} from "@schoolos/cartridge";
import { ContentTitle, ModuleLinkUrl, PageMarkdown, type CourseContentService, type CourseModule, type CourseOutline, type ImportedModule } from "@schoolos/curriculum";
import { MAX_CARTRIDGE_UPLOAD_BYTES, type CartridgeExportBody, type CartridgePreviewBody } from "./routes.ts";

/** A cartridge read and mapped to modules, with every item it can store and every one it cannot. */
interface CheckedCartridge {
  modules: ImportedModule[];
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
  for (const module of plan.modules) {
    const items = module.items.filter((item) => {
      const ok = ContentTitle.safeParse(item.title).success
        && (item.kind === "page" ? PageMarkdown.safeParse(item.body).success : ModuleLinkUrl.safeParse(item.url).success);
      if (!ok) skipped.push({ identifier: item.identifier, reason: "not-acceptable" });
      return ok;
    });
    if (items.length === 0) continue;
    const title = ContentTitle.safeParse(module.title).success ? module.title : "Imported module";
    modules.push({ title, items: items.map((item) => (item.kind === "page" ? { kind: "page", title: item.title, body: item.body } : { kind: "link", title: item.title, url: item.url })) });
  }
  return {
    modules,
    preview: {
      packageDigest: plan.packageDigest,
      title: plan.title,
      modules: modules.map((module) => ({
        title: module.title,
        items: module.items.map((item) => (item.kind === "page" ? { kind: "page", title: item.title, characters: item.body.length } : { kind: "link", title: item.title, url: item.url })),
      })),
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
  if ((await content.outline(subject, offeringId)).view !== "teacher") throw new SchoolOsError("forbidden", "Only the class's teachers can import into it.");
  return (await readUpload(base64)).preview;
}

/**
 * Imports a previewed cartridge into an offering as unpublished modules.
 *
 * @throws SchoolOsError `conflict` if the package is not the one previewed, and
 *   `validation-failed` if it holds nothing a module can store.
 */
export async function importCourseCartridge(
  content: CourseContentService,
  subject: VerifiedPrincipal,
  input: { offeringId: string; fileName: string; base64: string; packageDigest: string },
): Promise<{ modules: CourseModule[]; preview: CartridgePreviewBody }> {
  const checked = await readUpload(input.base64);
  if (checked.preview.packageDigest !== input.packageDigest) throw new SchoolOsError("conflict", "This is not the package you previewed; preview it again.");
  if (checked.modules.length === 0) throw new SchoolOsError("validation-failed", "The package holds no pages or links a module can store.");
  const modules = await content.importModules(subject, input.offeringId, checked.modules, {
    kind: "cartridge",
    fileName: input.fileName,
    packageDigest: checked.preview.packageDigest,
  });
  return { modules, preview: checked.preview };
}

/**
 * Exports an offering's modules (drafts included: only staff can export) as a Common Cartridge
 * 1.3 package. Activities are SchoolOS assignments a cartridge cannot carry; each is listed.
 */
export async function exportCourseCartridge(outline: CourseOutline, courseTitle: string, sectionName: string): Promise<CartridgeExportBody> {
  const pages = new Map(outline.pages.map((page) => [page.id, page]));
  const losses: CartridgeExportBody["losses"] = [];
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
    })),
  };
  const slug = `${courseTitle}-${sectionName}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "course";
  return { fileName: `${slug}.imscc`, base64: encodeBase64(await courseCartridgePackage(course)), losses };
}
