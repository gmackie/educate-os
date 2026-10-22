// Generates `src/playtrek/seed-rows.json` from PlayTrek's standards seeds
// (`packages/db/src/seed/standards/` at commit 7258e4347), applying the licensing decisions in
// `docs/schoolos/standards-licensing.md`:
//
// - CCSS statements are kept only where they match the publisher's own text on
//   thecorestandards.org word for word. The license grants copying and distribution, not
//   modification, so a transcription that differs is never shipped. Its row takes the publisher's
//   own statement instead (SCHO-63), read from the page by `ccss-publisher-text.ts`, when that
//   statement also matches the publisher's PDF edition; otherwise its text is withheld.
// - PlayTrek's CASEL indicators are PlayTrek's own writing organized under CASEL's competencies.
//   CASEL's terms are non-commercial and claim ownership of derivative materials, so their text
//   and sub-competency labels are withheld; codes, hierarchy and grade bands remain.
// - PlayTrek's ELOF goals paraphrase a U.S. federal publication and ship as written.
//
// Usage (authoring time only, never in a Worker; needs poppler's `pdftotext`):
//   node scripts/generate-playtrek-seeds.ts --playtrek <PlayTrek seed dir> --pages <cache dir>
// The publisher pages and PDFs are downloaded into the cache directory unless already there. Nothing from
// PlayTrek other than these seed modules is read; the modules only declare data.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CCSS_NOTICE, CCSS_PDFS, CCSS_SITE, inPdf, pdfReference, publisherPage, type PageStatement } from "./ccss-publisher-text.ts";

interface PlayTrekRow {
  code: string;
  shortCode: string;
  domain: string;
  cluster: string;
  description: string;
  gradeLevel: number;
  subject: string;
  parentCode: string;
}

type TextCheck =
  | "verbatim"
  | "formatting-only"
  | "replaced-from-publisher"
  | "differs"
  | "missing-from-reference"
  | "paraphrase"
  | "withheld-by-license";

const SOURCE_COMMIT = "7258e4347";

const { values } = parseArgs({ options: { playtrek: { type: "string" }, pages: { type: "string" } } });
if (values.playtrek === undefined || values.pages === undefined) {
  throw new Error("usage: generate-playtrek-seeds.ts --playtrek <dir> --pages <dir>");
}
const seedDir = resolve(values.playtrek);
const pageDir = resolve(values.pages);

/** Loads every exported array of seed rows from the PlayTrek seed modules, keyed by file name. */
async function loadSeeds(): Promise<Map<string, PlayTrekRow[]>> {
  const files = new Map<string, PlayTrekRow[]>();
  for (const file of readdirSync(seedDir).filter((f) => f.endsWith(".ts") && f !== "index.ts").toSorted()) {
    const mod = (await import(pathToFileURL(join(seedDir, file)).href)) as Record<string, unknown>;
    // casel-sel.ts exports per-competency arrays and their concatenation; take the concatenation.
    const arrays = Object.entries(mod).filter(([name, v]) => Array.isArray(v) && (file !== "casel-sel.ts" || name === "ALL_CASEL_STANDARDS"));
    files.set(file, arrays.flatMap(([, v]) => v as PlayTrekRow[]));
  }
  return files;
}

/** The publisher page that lists a CCSS code. */
function ccssPage(code: string): { url: string; file: string } {
  const parts = code.split(".");
  const path = parts[1] === "MATH" ? `Math/Content/${parts[3]}/${parts[4]}/` : `ELA-Literacy/${parts[2]}/${parts[3]}/`;
  return { url: `${CCSS_SITE}/${path}`, file: `${path.replaceAll("/", "_")}.html` };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replaceAll("&nbsp;", " ").replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&rsquo;", "’").replaceAll("&lsquo;", "‘").replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”").replaceAll("&ndash;", "–").replaceAll("&mdash;", "—")
    .replaceAll("&raquo;", "»").replaceAll("&amp;", "&");
}

const plain = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, "")).trim();

/** Reads the publisher's statements (code -> text) from a downloaded page. Footnote markers are dropped. */
function parsePage(html: string, into: Map<string, string>): void {
  const body = html.replace(/<sup>.*?<\/sup>/gs, "");
  for (const m of body.matchAll(/<div class="(?:standard|substandard)"><a [^>]*name="([^"]+)">[^<]*<\/a><br\/>(.*?)<\/div>/gs)) {
    into.set(m[1]!.toUpperCase(), plain(m[2]!));
  }
  // Kindergarten writing is published as a list rather than as standard blocks.
  for (const m of body.matchAll(/<li><a href="[^"]*">(CCSS\.[^<]+)<\/a> (.*?)<\/li>/gs)) {
    into.set(m[1]!.toUpperCase(), plain(m[2]!));
  }
}

async function loadReference(codes: Iterable<string>): Promise<Map<string, string>> {
  mkdirSync(pageDir, { recursive: true });
  const reference = new Map<string, string>();
  const pages = new Map([...codes].map((code) => [ccssPage(code).file, ccssPage(code).url]));
  for (const [file, url] of pages) {
    const path = join(pageDir, file);
    if (!existsSync(path)) {
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      writeFileSync(path, await response.text());
    }
    parsePage(readFileSync(path, "utf8"), reference);
  }
  return reference;
}

/**
 * Text that differs only in presentation: list labels written `(a)` rather than `a.`, dash and
 * quote glyphs, whitespace, and the full stop before a list label or at the end. Words must match.
 */
function presentation(text: string): string {
  return text
    .replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"")
    .replace(/\(([a-z])\)\s/g, "$1. ")
    .replace(/\s+/g, " ").trim()
    .replace(/\.(?= [a-z]\. )/g, "")
    .replace(/\.$/, "");
}

/** Compares a PlayTrek CCSS row with the publisher's statement, alone or followed by its lettered parts. */
function checkCcss(row: PlayTrekRow, reference: ReadonlyMap<string, string>): TextCheck {
  const code = row.code.toUpperCase();
  const statement = reference.get(code);
  if (statement === undefined) return "missing-from-reference";
  const parts = [...reference].filter(([k]) => k.startsWith(`${code}.`) && /^[A-Z]$/.test(k.slice(code.length + 1)))
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  const forms = [statement];
  if (parts.length > 0) forms.push(`${statement}${parts.map(([k, text]) => ` ${k.slice(-1).toLowerCase()}. ${text}`).join("")}`);
  if (forms.includes(row.description)) return "verbatim";
  return forms.map(presentation).includes(presentation(row.description)) ? "formatting-only" : "differs";
}

const FRAMEWORK_BY_FILE: ReadonlyArray<[RegExp, string]> = [
  [/^ccss-math-/, "ccss-math"],
  [/^ccss-ela-/, "ccss-ela"],
  [/^casel-sel\.ts$/, "casel-5"],
  [/^elof-prek\.ts$/, "head-start-elof"],
];

/**
 * The publisher's own statement for a row PlayTrek got wrong, in the form the row covers: the
 * statement alone, or followed by its lettered parts when PlayTrek's row included them. Undefined
 * unless it also matches the publisher's PDF edition.
 */
async function publisherReplacement(row: PlayTrekRow): Promise<string | undefined> {
  const page = await publisherPage(ccssPage(row.code).url.slice(CCSS_SITE.length + 1), pageDir);
  const code = row.code.toUpperCase();
  const byCode = new Map<string, PageStatement>(page.statements.map((s) => [s.anchor.toUpperCase(), s]));
  const statement = byCode.get(code);
  if (statement === undefined) return undefined;
  const parts = [...byCode].filter(([k]) => k.startsWith(`${code}.`) && /^[A-Z]$/.test(k.slice(code.length + 1)))
    .toSorted(([a], [b]) => (a < b ? -1 : 1));
  const withParts = /(^|\s)\(?[a-z][.)]\s/.test(row.description) && parts.length > 0;
  const text = withParts
    ? `${statement.text}${parts.map(([k, s]) => ` ${k.slice(-1).toLowerCase()}. ${s.text}`).join("")}`
    : statement.text;
  const pdf = row.code.split(".")[1] === "MATH" ? mathPdf : elaPdf;
  const verified = inPdf(statement.text, pdf) && parts.every(([, s]) => !withParts || inPdf(s.text, pdf));
  return verified ? text : undefined;
}

const seeds = await loadSeeds();
const ccssCodes = [...seeds].filter(([file]) => file.startsWith("ccss-")).flatMap(([, rows]) => rows.map((r) => r.code));
const reference = await loadReference(ccssCodes);
const [mathPdf, elaPdf] = [
  await pdfReference(CCSS_PDFS.math, pageDir, "Math_Standards1.pdf"),
  await pdfReference(CCSS_PDFS.ela, pageDir, "ELA_Standards1.pdf"),
];

const rows = [];
for (const [file, fileRows] of seeds) {
  const framework = FRAMEWORK_BY_FILE.find(([pattern]) => pattern.test(file))?.[1];
  if (framework === undefined) throw new Error(`no catalog framework for ${file}`);
  for (const row of fileRows) {
    let textCheck: TextCheck = framework.startsWith("ccss-")
      ? checkCcss(row, reference)
      : framework === "casel-5" ? "withheld-by-license" : "paraphrase";
    const replacement = textCheck === "differs" ? await publisherReplacement(row) : undefined;
    if (replacement !== undefined) textCheck = "replaced-from-publisher";
    const shipsText = textCheck === "verbatim" || textCheck === "formatting-only" || textCheck === "paraphrase";
    rows.push({
      framework,
      code: row.code,
      shortCode: row.shortCode,
      domain: row.domain,
      cluster: framework === "casel-5" ? null : row.cluster,
      statement: shipsText ? row.description : replacement ?? null,
      textCheck,
      gradeLevel: row.gradeLevel,
      subject: row.subject,
      parentCode: row.parentCode,
    });
  }
}

const header = {
  // The CCSS license requires this notice on any publication of the standards, this file included.
  notices: {
    "ccss-math": CCSS_NOTICE,
    "ccss-ela": CCSS_NOTICE,
    "head-start-elof": "Paraphrased from the Head Start Early Learning Outcomes Framework: Ages Birth to Five (U.S. Department of Health and Human Services, Office of Head Start, 2015).",
  },
  source: { path: "packages/db/src/seed/standards/", commit: SOURCE_COMMIT },
  ccssReference: { site: CCSS_SITE, pdfs: Object.values(CCSS_PDFS), retrievedOn: new Date().toLocaleDateString("en-CA") },
};
// One row per line, so a regenerated file diffs row by row.
const json = `${JSON.stringify(header).slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
writeFileSync(new URL("../src/playtrek/seed-rows.json", import.meta.url), json);
const counts = Object.groupBy(rows, (r) => `${r.framework}:${r.textCheck}`);
console.log(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v?.length])));
