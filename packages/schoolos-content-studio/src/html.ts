/**
 * Metadata extraction from imported HTML. The page is untrusted data: nothing here executes it,
 * follows its links or treats its text as instructions. The scanner is deliberately simple and
 * linear-time (no nested quantifiers), because a hostile page controls its input.
 */

/** Where a license hint was found on a page. */
export type LicenseHintSource = "link-rel-license" | "meta" | "cc-badge";

/** A piece of license evidence found on a page, kept as found. */
export interface LicenseHint {
  source: LicenseHintSource;
  /** The license URL, badge image URL or meta value, resolved against the page URL when it is a URL. */
  value: string;
}

/** What the studio reads from an HTML page. */
export interface PageMetadata {
  title: string | undefined;
  /** The page's `<link rel=canonical>`, resolved against the page URL, when it is an https URL. */
  canonicalUrl: string | undefined;
  /** The `lang` attribute of the `<html>` element. */
  lang: string | undefined;
  licenseHints: LicenseHint[];
  /** The author or rights holder the page names in its metadata. */
  attribution: string | undefined;
  images: { total: number; withoutAlt: number };
  /** The `src` of each external script, resolved against the page URL. */
  externalScripts: string[];
  inlineScripts: number;
  /** The page's visible text, with markup, scripts and styles removed. */
  text: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the HTML character references metadata commonly uses. Unknown named references are kept. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, ref: string) => {
    if (ref.startsWith("#")) {
      const code = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[ref.toLowerCase()] ?? match;
  });
}

interface Tag {
  name: string;
  attributes: Map<string, string>;
}

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?>/g;
const ATTRIBUTE = /([^\s"'=<>/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function* tags(html: string): Generator<Tag> {
  for (const match of html.matchAll(TAG)) {
    const attributes = new Map<string, string>();
    for (const attribute of (match[2] ?? "").matchAll(ATTRIBUTE)) {
      const name = attribute[1]!.toLowerCase();
      if (!attributes.has(name)) attributes.set(name, decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
    }
    yield { name: match[1]!.toLowerCase(), attributes };
  }
}

function resolve(value: string, base: string): string | undefined {
  return URL.canParse(value, base) ? new URL(value, base).href : undefined;
}

const relTokens = (tag: Tag) => (tag.attributes.get("rel") ?? "").toLowerCase().split(/\s+/);

/** Meta names and properties that carry license or rights statements. */
const LICENSE_META = new Set(["license", "dc.rights", "dcterms.rights", "dcterms.license", "dc.license", "og:license"]);
/** Meta names that name an author or rights holder. */
const ATTRIBUTION_META = new Set(["author", "dc.creator", "dcterms.creator", "dcterms.rightsholder", "citation_author", "copyright"]);

/** Image hosts that serve Creative Commons license badges. */
const CC_BADGE_HOSTS = new Set(["i.creativecommons.org", "licensebuttons.net", "mirrors.creativecommons.org"]);

/**
 * `html` with every span from a match of `open` to the next match of `close` replaced by a space,
 * in one pass. An unclosed span runs to the end. Unlike a lazy regex, this stays linear when a
 * hostile page opens thousands of spans it never closes.
 */
function stripSpans(html: string, open: RegExp, close: RegExp): string {
  let out = "";
  let index = 0;
  for (;;) {
    open.lastIndex = index;
    const start = open.exec(html);
    if (start === null) return out + html.slice(index);
    out += `${html.slice(index, start.index)} `;
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(html);
    if (end === null) return out;
    index = end.index + end[0].length;
  }
}

/** The visible text of a page, with scripts, styles, comments and markup removed and whitespace collapsed. */
export function visibleText(html: string): string {
  let text = stripSpans(html, /<!--/g, /-->/g);
  text = stripSpans(text, /<script\b/gi, /<\/script\s*>/gi);
  text = stripSpans(text, /<style\b/gi, /<\/style\s*>/gi);
  return decodeEntities(text.replace(/<[^<>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Reads a page's metadata. `pageUrl` is the URL it was fetched from, used to resolve relative links. */
export function extractPageMetadata(html: string, pageUrl: string): PageMetadata {
  const metadata: PageMetadata = {
    title: undefined,
    canonicalUrl: undefined,
    lang: undefined,
    licenseHints: [],
    attribution: undefined,
    images: { total: 0, withoutAlt: 0 },
    externalScripts: [],
    inlineScripts: 0,
    text: visibleText(html),
  };
  const title = /<title\b[^<>]*>([^<]*)<\/title\s*>/i.exec(html)?.[1];
  if (title !== undefined && title.trim() !== "") metadata.title = decodeEntities(title).replace(/\s+/g, " ").trim();

  for (const tag of tags(html)) {
    const attr = (name: string) => tag.attributes.get(name);
    switch (tag.name) {
      case "html":
        metadata.lang ??= attr("lang")?.trim() || undefined;
        break;
      case "link":
      case "a": {
        const href = attr("href");
        if (href === undefined) break;
        const rel = relTokens(tag);
        if (rel.includes("license")) {
          const value = resolve(href, pageUrl);
          if (value !== undefined) metadata.licenseHints.push({ source: "link-rel-license", value });
        }
        if (tag.name === "link" && rel.includes("canonical") && metadata.canonicalUrl === undefined) {
          const value = resolve(href, pageUrl);
          if (value?.startsWith("https://")) metadata.canonicalUrl = value;
        }
        break;
      }
      case "meta": {
        const key = (attr("name") ?? attr("property") ?? "").toLowerCase();
        const content = attr("content")?.trim();
        if (!content) break;
        if (LICENSE_META.has(key)) {
          const value = /^https?:\/\//i.test(content) && URL.canParse(content) ? new URL(content).href : content;
          metadata.licenseHints.push({ source: "meta", value });
        }
        if (ATTRIBUTION_META.has(key)) metadata.attribution ??= content;
        break;
      }
      case "img": {
        metadata.images.total += 1;
        if (!tag.attributes.has("alt")) metadata.images.withoutAlt += 1;
        const src = attr("src");
        const value = src === undefined ? undefined : resolve(src, pageUrl);
        if (value !== undefined && CC_BADGE_HOSTS.has(new URL(value).hostname)) {
          metadata.licenseHints.push({ source: "cc-badge", value });
        }
        break;
      }
      case "script": {
        const src = attr("src");
        const value = src === undefined ? undefined : resolve(src, pageUrl);
        if (value === undefined) metadata.inlineScripts += 1;
        else metadata.externalScripts.push(value);
        break;
      }
    }
  }
  return metadata;
}
