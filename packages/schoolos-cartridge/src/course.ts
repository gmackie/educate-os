// A course's modules to and from a Common Cartridge (SCHO-186). Import maps a cartridge's
// organization onto modules of pages and links, for a teacher to preview before anything is stored;
// export writes a course's modules as a Common Cartridge 1.3 package. Pages travel as `webcontent`
// HTML files. On the way in, an HTML page is reduced to text (scripts, styles and every tag
// dropped), so no markup crosses into SchoolOS; a page SchoolOS wrote carries its Markdown verbatim,
// so a course survives the round trip unchanged.
import { writeZip } from "@schoolos/zip";
import type { ManifestResource, OrganizationItem } from "./manifest.ts";
import type { CartridgePackage } from "./package.ts";
import { packagePath, planCartridgeImport } from "./plan.ts";
import { QTI_ITEM_TYPE, QTI_TEST_TYPE, readQtiQuiz, type QtiLossReason, type QtiQuizItem } from "./qti.ts";
import { childElement, parseXml, type XmlElement, type XmlNode } from "./xml.ts";

/** One item of an imported or exported module. */
export type CourseCartridgeItem =
  | { kind: "page"; identifier: string; title: string; body: string }
  | { kind: "link"; identifier: string; title: string; url: string };

/**
 * A discussion topic a module carries (`imsdt_xmlv1p*`, SCHO-190): its title and prompt, the prompt
 * reduced to text as a page is. It becomes a discussion topic in the module, not a module item.
 */
export interface CourseCartridgeDiscussion {
  identifier: string;
  title: string;
  prompt: string;
}

/**
 * A quiz a module carries: a QTI 2.1 or 3.0 test, or a lone item (SCHO-191). Its items are those
 * SchoolOS scores the same way; every other item is listed as skipped. It becomes a draft quiz in
 * the module, not a module item.
 */
export interface CourseCartridgeQuiz {
  identifier: string;
  title: string;
  items: QtiQuizItem[];
}

/** A module: a titled, ordered list of pages and links, and the discussion topics and quizzes placed in it. */
export interface CourseCartridgeModule {
  identifier: string;
  title: string;
  items: CourseCartridgeItem[];
  /** Its discussion topics, in order (SCHO-190). */
  discussions: CourseCartridgeDiscussion[];
  /** Its quizzes, in order (SCHO-191). */
  quizzes: CourseCartridgeQuiz[];
}

/** Why a placement in the cartridge was not carried into a module. */
export type CourseCartridgeSkipReason =
  /** An LTI tool, which launches only through an approved registration and has no place in a module. */
  | "lti-tool"
  /** A resource type a module cannot hold: QTI 1.2, files other than HTML pages. */
  | "unsupported-type"
  /** A QTI assessment none of whose items SchoolOS can score (SCHO-191); each item is listed too. */
  | "quiz-without-items"
  /** A QTI item or assessment that was not carried (SCHO-191): see {@link QtiLossReason}. */
  | QtiLossReason
  /** A discussion topic whose file is not a readable `<topic>` (SCHO-190). */
  | "invalid-discussion"
  /** A web link whose URL the Content Studio's checks refuse, such as a non-https or private address. */
  | "link-refused"
  /** A web link with no usable URL. */
  | "invalid-link"
  /** An item naming a resource the manifest does not define. */
  | "missing-resource"
  /** A resource whose file the package does not contain. */
  | "missing-file"
  /** An HTML page that is not UTF-8. */
  | "page-not-utf8";

/** One placement that was not carried, and where it was. Never its content. */
export interface CourseCartridgeSkip {
  identifier: string;
  reason: CourseCartridgeSkipReason;
  /** The resource type, when there is one. */
  type?: string;
}

/** What a cartridge would become as course modules: nothing here has been stored. */
export interface CourseCartridgePlan {
  packageDigest: string;
  title: string;
  modules: CourseCartridgeModule[];
  skipped: CourseCartridgeSkip[];
  /** Modules nested below the top level, whose items were flattened into their top-level module. */
  flattened: string[];
  /** Pages cut to {@link MAX_IMPORTED_PAGE_LENGTH} characters, prompts to {@link MAX_IMPORTED_PROMPT_LENGTH}, and quizzes cut to fit (SCHO-191). */
  truncated: string[];
}

/** The longest page an import keeps, in characters; longer pages are cut and listed. */
export const MAX_IMPORTED_PAGE_LENGTH = 20_000;

/** The longest discussion prompt an import keeps, in characters (SCHO-190); longer ones are cut and listed. */
export const MAX_IMPORTED_PROMPT_LENGTH = 10_000;

const DISCUSSION_TOPIC = /^imsdt_xmlv1p[0-3]$/;
const DISCUSSION_NAMESPACE = "http://www.imsglobal.org/xsd/imsccv1p3/imsdt_v1p3";

/** An element's character data exactly as written, entity references decoded: line breaks matter in a prompt. */
function rawText(element: XmlElement | undefined): string {
  if (element === undefined) return "";
  const walk = (node: XmlNode): string => (typeof node === "string" ? node : node.children.map(walk).join(""));
  return walk(element);
}

const WEB_LINK = /^imswl_xmlv1p[0-3]$/;
const LTI_LINK = /^imsbasiclti_xmlv1p[0-3]$/;
const HTML_FILE = /\.x?html?$/i;
const MARKDOWN_BLOCK = /<pre class="schoolos-markdown">([\s\S]*?)<\/pre>/;
const UNTITLED = "Untitled";

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A page's text from its HTML: the Markdown SchoolOS wrote into it, verbatim, or else the text of an
 * arbitrary page with headings and list items marked and every tag, script and style removed.
 */
export function pageTextFromHtml(html: string): string {
  const ours = MARKDOWN_BLOCK.exec(html);
  if (ours !== null) return decodeEntities(ours[1]!);
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|table|blockquote|pre|section|article)\s*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** What one placement became: a module item, a discussion topic or a quiz. */
type Placed =
  | { as: "item"; value: CourseCartridgeItem }
  | { as: "discussion"; value: CourseCartridgeDiscussion }
  | { as: "quiz"; value: CourseCartridgeQuiz };

function tag<A extends Placed["as"]>(as: A, value: Extract<Placed, { as: A }>["value"] | undefined): Placed | undefined {
  return value === undefined ? undefined : ({ as, value } as Placed);
}

/**
 * Maps a read package to course modules. Each top-level module of the organization becomes one
 * module holding, in order, the pages and links anywhere beneath it; top-level items outside any
 * module form one more module, named after the cartridge. Web links are checked as the Content
 * Studio would check a URL a teacher pasted (`planCartridgeImport`); HTML `webcontent` becomes a
 * page of text; discussion topics and QTI 2.1 and 3.0 assessments go with their module. LTI tools
 * and every other resource are skipped and listed.
 */
export function planCourseCartridge(pkg: CartridgePackage): CourseCartridgePlan {
  const plan = planCartridgeImport(pkg);
  const links = new Map(plan.links.map((link) => [link.provenance.resourceIdentifier, link]));
  const resources = new Map<string, ManifestResource>();
  for (const resource of pkg.manifest.resources) if (!resources.has(resource.identifier)) resources.set(resource.identifier, resource);
  const skipped: CourseCartridgeSkip[] = [];
  const flattened: string[] = [];
  const truncated: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const title = (plan.metadata.title ?? "").trim() || UNTITLED;

  // A discussion topic: its `<topic>` file's title and prompt. An HTML prompt is reduced to text;
  // a plain one (as SchoolOS writes them) is kept verbatim, so a prompt survives the round trip.
  const discussionFor = (identifier: string, itemTitle: string, resource: ManifestResource): CourseCartridgeDiscussion | undefined => {
    const type = resource.type.slice(0, 200);
    const href = resource.files[0] ?? resource.href;
    const bytes = href === undefined ? undefined : pkg.files.get(packagePath(href));
    if (bytes === undefined) return void skipped.push({ identifier, reason: "missing-file", type });
    let topic: XmlElement;
    try {
      topic = parseXml(decoder.decode(bytes));
    } catch {
      return void skipped.push({ identifier, reason: "invalid-discussion", type });
    }
    if (topic.local !== "topic") return void skipped.push({ identifier, reason: "invalid-discussion", type });
    const text = childElement(topic, "text");
    const html = text === undefined || (text.attributes.get("texttype") ?? "text/html") !== "text/plain";
    let prompt = html ? pageTextFromHtml(rawText(text)) : rawText(text).trim();
    if (prompt.length > MAX_IMPORTED_PROMPT_LENGTH) {
      prompt = prompt.slice(0, MAX_IMPORTED_PROMPT_LENGTH);
      truncated.push(identifier);
    }
    const title = rawText(childElement(topic, "title")).replace(/\s+/g, " ").trim().slice(0, 200) || itemTitle;
    return { identifier, title, prompt };
  };

  // A quiz (SCHO-191): a QTI test's items, or a lone QTI item. What it cannot carry is listed.
  const quizFor = (identifier: string, itemTitle: string, resource: ManifestResource, kind: "test" | "item"): CourseCartridgeQuiz | undefined => {
    const type = resource.type.slice(0, 200);
    const href = resource.files[0] ?? resource.href;
    if (href === undefined) return void skipped.push({ identifier, reason: "missing-file", type });
    const read = readQtiQuiz(pkg.files, packagePath(href), kind, identifier);
    if ("loss" in read) return void skipped.push({ ...read.loss, type: read.loss.type ?? type });
    skipped.push(...read.losses);
    if (read.truncated) truncated.push(identifier);
    if (read.items.length === 0) return void skipped.push({ identifier, reason: "quiz-without-items", type });
    return { identifier, title: (kind === "test" ? read.title : "") || itemTitle || read.title, items: read.items };
  };

  const itemFor = (item: OrganizationItem): Placed | undefined => {
    const identifier = item.identifier.slice(0, 200);
    const resource = resources.get(item.resourceRef!);
    if (resource === undefined) return void skipped.push({ identifier, reason: "missing-resource" });
    const type = resource.type.slice(0, 200);
    const itemTitle = (item.title ?? resource.metadata.title ?? "").trim().slice(0, 200) || UNTITLED;
    if (LTI_LINK.test(resource.type)) return void skipped.push({ identifier, reason: "lti-tool", type });
    if (DISCUSSION_TOPIC.test(resource.type)) return tag("discussion", discussionFor(identifier, itemTitle, resource));
    if (QTI_TEST_TYPE.test(resource.type)) return tag("quiz", quizFor(identifier, itemTitle, resource, "test"));
    if (QTI_ITEM_TYPE.test(resource.type)) return tag("quiz", quizFor(identifier, itemTitle, resource, "item"));
    if (WEB_LINK.test(resource.type)) {
      const link = links.get(resource.identifier.slice(0, 200));
      if (link === undefined) return void skipped.push({ identifier, reason: "invalid-link", type });
      if (link.review.status === "refused") return void skipped.push({ identifier, reason: "link-refused", type });
      return tag("item", { kind: "link", identifier, title: item.title?.trim().slice(0, 200) || link.title.slice(0, 200), url: link.url });
    }
    const href = resource.files[0] ?? resource.href;
    if (resource.type !== "webcontent" || href === undefined || !HTML_FILE.test(href)) return void skipped.push({ identifier, reason: "unsupported-type", type });
    const bytes = pkg.files.get(packagePath(href));
    if (bytes === undefined) return void skipped.push({ identifier, reason: "missing-file", type });
    let html: string;
    try {
      html = decoder.decode(bytes);
    } catch {
      return void skipped.push({ identifier, reason: "page-not-utf8", type });
    }
    let body = pageTextFromHtml(html);
    if (body.length > MAX_IMPORTED_PAGE_LENGTH) {
      body = body.slice(0, MAX_IMPORTED_PAGE_LENGTH);
      truncated.push(identifier);
    }
    return tag("item", { kind: "page", identifier, title: itemTitle, body });
  };

  const collect = (items: readonly OrganizationItem[], nested: boolean): Placed[] =>
    items.flatMap((item) => {
      const own = item.resourceRef === undefined ? [] : [itemFor(item)].filter((i) => i !== undefined);
      if (item.children.length === 0) return own;
      if (nested) flattened.push(item.identifier.slice(0, 200));
      return [...own, ...collect(item.children, true)];
    });
  const moduleOf = (identifier: string, moduleTitle: string, placed: Placed[]): CourseCartridgeModule => ({
    identifier,
    title: moduleTitle,
    items: placed.flatMap((entry) => (entry.as === "item" ? [entry.value] : [])),
    discussions: placed.flatMap((entry) => (entry.as === "discussion" ? [entry.value] : [])),
    quizzes: placed.flatMap((entry) => (entry.as === "quiz" ? [entry.value] : [])),
  });

  const modules: CourseCartridgeModule[] = [];
  const loose = pkg.manifest.items.filter((item) => item.children.length === 0);
  if (loose.length > 0) modules.push(moduleOf(plan.manifestIdentifier || "top-level", title, collect(loose, false)));
  for (const item of pkg.manifest.items) {
    if (item.children.length === 0) continue;
    modules.push(moduleOf(item.identifier.slice(0, 200), (item.title ?? "").trim().slice(0, 200) || UNTITLED, collect([item], false)));
  }
  return { packageDigest: plan.packageDigest, title, modules: modules.filter((m) => m.items.length > 0 || m.discussions.length > 0 || m.quizzes.length > 0), skipped, flattened, truncated };
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A course to export. Items are written in order; IDs in the package are positional. */
export interface CourseCartridgeExport {
  title: string;
  /** A BCP 47 language tag for the package metadata. */
  language: string;
  modules: readonly {
    title: string;
    items: readonly ({ kind: "page"; title: string; body: string } | { kind: "link"; title: string; url: string })[];
    /** The module's discussion topics, written after its items (SCHO-190). */
    discussions?: readonly { title: string; prompt: string }[];
  }[];
}

/**
 * Writes a course's modules as Common Cartridge 1.3 files: an organization with one item per
 * module, a `webcontent` HTML file per page (its Markdown kept in a `<pre>`, escaped) and a web
 * link per link. Returns the files by path, manifest included.
 */
export function courseCartridgeFiles(course: CourseCartridgeExport): Map<string, string> {
  const files = new Map<string, string>();
  const organization: string[] = [];
  const resources: string[] = [];
  let n = 0;
  for (const [m, module] of course.modules.entries()) {
    const items: string[] = [];
    for (const item of module.items) {
      n++;
      if (item.kind === "page") {
        const path = `pages/page-${n}.html`;
        files.set(path, [
          `<!DOCTYPE html>`,
          `<html lang="${escapeXml(course.language)}"><head><meta charset="utf-8"><title>${escapeXml(item.title)}</title></head>`,
          `<body><h1>${escapeXml(item.title)}</h1><pre class="schoolos-markdown">${escapeXml(item.body)}</pre></body></html>`,
          ``,
        ].join("\n"));
        resources.push(`    <resource identifier="R_${n}" type="webcontent" href="${path}"><file href="${path}"/></resource>`);
      } else {
        const path = `links/link-${n}.xml`;
        files.set(path, [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3">`,
          `  <title>${escapeXml(item.title)}</title>`,
          `  <url href="${escapeXml(item.url)}"/>`,
          `</webLink>`,
          ``,
        ].join("\n"));
        resources.push(`    <resource identifier="R_${n}" type="imswl_xmlv1p3"><file href="${path}"/></resource>`);
      }
      items.push(`          <item identifier="I_${n}" identifierref="R_${n}"><title>${escapeXml(item.title)}</title></item>`);
    }
    for (const topic of module.discussions ?? []) {
      n++;
      const path = `discussions/topic-${n}.xml`;
      files.set(path, [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<topic xmlns="${DISCUSSION_NAMESPACE}">`,
        `  <title>${escapeXml(topic.title)}</title>`,
        `  <text texttype="text/plain">${escapeXml(topic.prompt)}</text>`,
        `</topic>`,
        ``,
      ].join("\n"));
      resources.push(`    <resource identifier="R_${n}" type="imsdt_xmlv1p3"><file href="${path}"/></resource>`);
      items.push(`          <item identifier="I_${n}" identifierref="R_${n}"><title>${escapeXml(topic.title)}</title></item>`);
    }
    organization.push(`        <item identifier="M_${m + 1}"><title>${escapeXml(module.title)}</title>`, ...items, `        </item>`);
  }
  files.set("imsmanifest.xml", [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<manifest identifier="SchoolOSCourse" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">`,
    `  <metadata>`,
    `    <schema>IMS Common Cartridge</schema>`,
    `    <schemaversion>1.3.0</schemaversion>`,
    `    <lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string language="${escapeXml(course.language)}">${escapeXml(course.title)}</lomimscc:string></lomimscc:title></lomimscc:general></lomimscc:lom>`,
    `  </metadata>`,
    `  <organizations>`,
    `    <organization identifier="O_1" structure="rooted-hierarchy">`,
    `      <item identifier="LearningModules">`,
    ...organization,
    `      </item>`,
    `    </organization>`,
    `  </organizations>`,
    `  <resources>`,
    ...resources,
    `  </resources>`,
    `</manifest>`,
    ``,
  ].join("\n"));
  return files;
}

/** {@link courseCartridgeFiles} zipped as an `.imscc` package, manifest first. */
export async function courseCartridgePackage(course: CourseCartridgeExport): Promise<Uint8Array<ArrayBuffer>> {
  const files = courseCartridgeFiles(course);
  const encoder = new TextEncoder();
  const paths = ["imsmanifest.xml", ...[...files.keys()].filter((path) => path !== "imsmanifest.xml")];
  return writeZip(paths.map((path) => ({ path, bytes: encoder.encode(files.get(path)!) })));
}
