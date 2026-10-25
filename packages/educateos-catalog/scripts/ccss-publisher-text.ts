// Reads CCSS statements from the publisher's own pages on thecorestandards.org and checks them
// against the publisher's PDF editions. Shared by `generate-playtrek-seeds.ts` (which replaces the
// K-8 transcriptions that failed verification) and `generate-ccss-publisher-rows.ts` (high school
// and the 6-12 literacy standards). Authoring time only, under Node.
//
// The pages mark text up with HTML. A statement is turned into plain text by fixed rules, so the
// same page always yields the same text:
//
// - Italic, bold and link tags are dropped and their text kept; paragraphs are joined by a space.
// - `<sup>a</sup>/<sub>b</sub>` is a stacked fraction and becomes `a/b`.
// - The modeling star (`<sup>*</sup>` or `<sup>✭</sup>`) is removed and reported, not kept as text.
// - A number in `<sup>` right after `.`, `,`, `;` or `:` is a footnote marker and is dropped.
// - Any other `<sup>x</sup>` is an exponent, written `^x`, or `^(x)` when x is more than one token.
// - `<sub>x</sub>` is a subscript, written `_x` or `_(x)`.
// - Any other tag fails the run rather than being guessed at.
//
// Those are changes of presentation only, the same class C02 accepted as "formatting-only": the
// words are the publisher's.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The publisher's site. */
export const CCSS_SITE = "https://www.thecorestandards.org";
/** The notice the CCSS Public License requires on any publication of the standards. */
export const CCSS_NOTICE =
  "© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.";
/** The publisher's PDF editions, the second reference every statement is checked against. */
export const CCSS_PDFS = {
  math: "https://corestandards.org/wp-content/uploads/2023/09/Math_Standards1.pdf",
  ela: "https://corestandards.org/wp-content/uploads/2023/09/ELA_Standards1.pdf",
} as const;

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", quot: "\"", lt: "<", gt: ">", amp: "&", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  ndash: "–", mdash: "—", raquo: "»", theta: "θ", pi: "π", radic: "√", deg: "°", ne: "≠", times: "×",
  ge: "≥", le: "≤", asymp: "≈", plusmn: "±", minus: "−", divide: "÷", cent: "¢",
};

/** Decodes the entities the CCSS pages use; an unknown named entity fails the run. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => {
      const decoded = ENTITIES[name];
      if (decoded === undefined) throw new Error(`unknown entity ${entity}`);
      return decoded;
    });
}

/** A statement as plain text, and whether it carried the modeling star. */
export interface PublisherText {
  text: string;
  modeling: boolean;
}

const token = (x: string, mark: string) => (/^[A-Za-z0-9.]+$/.test(x) ? `${mark}${x}` : `${mark}(${x})`);

/** Turns a statement's HTML into plain text by the rules in this module's header. */
export function publisherText(html: string): PublisherText {
  let modeling = false;
  let text = html
    .replace(/<\/?(?:i|b|em|strong)>/g, "")
    .replace(/<a [^>]*>|<\/a>|<\/li>/g, "")
    .replace(/<\/p>\s*<p>/g, " ")
    .replace(/<\/?p>/g, "")
    .replace(/<sup>([^<]*)<\/sup>\s*\/\s*<sub>([^<]*)<\/sub>/g, "$1/$2")
    .replace(/<sup>\s*[*✭★]\s*(?:<\/sup>)?/g, () => {
      modeling = true;
      return "";
    })
    .replace(/([.,;:])<sup>\d+<\/sup>/g, "$1")
    .replace(/<sup>([^<]+)<\/sup>/g, (_, x: string) => token(x.trim(), "^"))
    .replace(/<sub>([^<]+)<\/sub>/g, (_, x: string) => token(x.trim(), "_"));
  const stray = /<[^>]+>/.exec(text);
  if (stray !== null) throw new Error(`unexpected markup ${stray[0]} in: ${html.slice(0, 120)}`);
  text = decodeEntities(text).replace(/\s+/g, " ").trim();
  return { text, modeling };
}

/** One statement on a publisher page, in page order, with the headings above it. */
export interface PageStatement {
  /** The publisher's identifier, as the page's anchor writes it, such as `CCSS.Math.Content.HSA.SSE.A.1`. */
  anchor: string;
  /** `standard`, or `component` for a lettered part. */
  kind: "standard" | "component";
  text: string;
  modeling: boolean;
  /** The `<h4>` heading the statement sits under: a math cluster, or an ELA heading. */
  heading: string;
}

/** A downloaded page: its `<h1>` parts and its statements. */
export interface PublisherPage {
  url: string;
  /** The `<h1>` split on `»`, such as `["High School: Algebra", "Seeing Structure in Expressions"]`. */
  title: string[];
  statements: PageStatement[];
}

/**
 * Reads a downloaded page's title and its statements, with the heading each sits under. A page
 * that publishes its standards another way (kindergarten writing is a list) has none.
 */
export function parsePublisherPage(url: string, html: string): PublisherPage {
  const h1 = /<h1>(.*?)<\/h1>/s.exec(html);
  if (h1 === null) throw new Error(`${url}: no title`);
  const title = decodeEntities(h1[1]!).split("»").map((part) => part.trim());
  const body = html.slice(html.indexOf("<section class=\"content"), html.indexOf("<p class=\"citation\">") === -1 ? undefined : html.indexOf("<p class=\"citation\">"));
  const statements: PageStatement[] = [];
  let heading = "";
  const pattern = /<h4>(.*?)<\/h4>|<div class="(standard|substandard)"><a [^>]*name="([^"]+)">[^<]*<\/a><br\/>(.*?)<\/div>/gs;
  for (const m of body.matchAll(pattern)) {
    if (m[1] !== undefined) {
      heading = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim().replace(/:$/, "");
      continue;
    }
    statements.push({ anchor: m[3]!, kind: m[2] === "standard" ? "standard" : "component", ...publisherText(m[4]!), heading });
  }
  return { url, title, statements };
}

/** Downloads `url` into `dir` as `file` unless it is already there, and returns the file's path. */
export async function cachedFetch(url: string, dir: string, file: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (!existsSync(path)) {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  return path;
}

/** A publisher page by its path below the site, cached under the name the C02 generator uses. */
export async function publisherPage(path: string, dir: string): Promise<PublisherPage> {
  const url = `${CCSS_SITE}/${path}`;
  return parsePublisherPage(url, readFileSync(await cachedFetch(url, dir, `${path.replaceAll("/", "_")}.html`), "utf8"));
}

/**
 * The comparison key: the letters and digits of a text, in order, after Unicode compatibility
 * normalization (so `x²` and `x^2` agree). Whitespace, punctuation, hyphenation at a line break,
 * exponent and fraction markup all fall away; every word and number must still match exactly.
 */
export const wordKey = (text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The publisher's PDF edition as one comparison key, extracted with `pdftotext` (poppler). The PDF
 * is read only as data and never executed.
 */
export async function pdfReference(url: string, dir: string, file: string): Promise<string> {
  const path = await cachedFetch(url, dir, file);
  return wordKey(execFileSync("pdftotext", ["-enc", "UTF-8", path, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }));
}

/** Whether every word and number of `text` appears, in order and contiguously, in the PDF edition. */
export function inPdf(text: string, reference: string): boolean {
  const key = wordKey(text);
  return key.length > 0 && reference.includes(key);
}
