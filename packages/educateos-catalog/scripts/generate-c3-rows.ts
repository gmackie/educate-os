// Generates `src/publisher/c3-rows.json`: the C3 Framework's grade-band indicators, transcribed from
// the NCSS publication (SCHO-63). NCSS's title page says the text "may be freely reproduced";
// `docs/educateos/standards-licensing.md` quotes it. EducateOS writes none of this text.
//
// The indicators are set in four-column tables, one column per grade band (by the end of grade 2,
// 5, 8 and 12). `pdftotext -bbox` gives every word with its position; each word is assigned to
// the column whose indicator codes it lines up under, and a column's words are read down the page
// until the next indicator code in that column, a gap of more than two lines, or the page footer.
//
// Words broken across a line with a hyphen ("pow-" / "ers") are joined only by the rules in
// `joinBrokenWord`, which never guess: a break nothing settles fails the run until it is added to
// HYPHEN_DECISIONS, with the reason recorded.
//
// Every indicator is then checked against a second reading of the same PDF, `pdftotext` in its
// default reading order, word for word (`wordKey`), and must be followed there by the start of
// something else, so a cell cut short fails too. One that does not match ships with its text
// withheld. Placeholder cells ("Begins in grades 3–5") are not indicators and are skipped.
//
// Usage (authoring time only, never in a Worker; needs poppler's `pdftotext`):
//   node scripts/generate-c3-rows.ts --pdf <cache dir>
// The PDF is downloaded into the cache directory unless already there, and read only as data.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { cachedFetch, decodeEntities, wordKey } from "./ccss-publisher-text.ts";

const C3_PDF = "https://www.socialstudies.org/sites/default/files/c3/C3-Framework-for-Social-Studies.pdf";
const C3_CITATION =
  "National Council for the Social Studies (NCSS), The College, Career, and Civic Life (C3) Framework for Social Studies State Standards: Guidance for Enhancing the Rigor of K-12 Civics, Economics, Geography, and History (Silver Spring, MD: NCSS, 2013).";

const { values } = parseArgs({ options: { pdf: { type: "string" } } });
if (values.pdf === undefined) throw new Error("usage: generate-c3-rows.ts --pdf <dir>");
const pdf = await cachedFetch(C3_PDF, resolve(values.pdf), "C3-Framework-for-Social-Studies.pdf");
const pdftotext = (...args: string[]) =>
  execFileSync("pdftotext", ["-enc", "UTF-8", ...args, pdf, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const BANDS = ["K-2", "3-5", "6-8", "9-12"] as const;
type Band = (typeof BANDS)[number];
const LEVELS: Readonly<Record<Band, readonly string[]>> = {
  "K-2": ["KG", "01", "02"],
  "3-5": ["03", "04", "05"],
  "6-8": ["06", "07", "08"],
  "9-12": ["09", "10", "11", "12"],
};
const CODE = /^D([1-4])\.(?:(Civ|Eco|Geo|His)\.)?(\d{1,2})\.(K-2|3-5|6-8|9-12)\.$/;

/**
 * Line-broken words that the C3 text itself and the system dictionary do not settle. Each was read
 * in the PDF by eye; the key is the two halves joined by `-`.
 */
const HYPHEN_DECISIONS: Readonly<Record<string, "join" | "keep">> = {};

interface Word {
  page: number;
  x: number;
  y: number;
  height: number;
  text: string;
}

function readWords(): Word[] {
  const words: Word[] = [];
  let page = 0;
  for (const line of pdftotext("-bbox").split("\n")) {
    if (line.includes("<page ")) page++;
    const m = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">(.*)<\/word>/.exec(line);
    if (m === null) continue;
    words.push({ page, x: Number(m[1]), y: Number(m[2]), height: Number(m[3]) - Number(m[2]), text: decodeEntities(m[4]!) });
  }
  return words;
}

const words = readWords();
// Words the C3 text sets without a line break, for settling line-broken ones.
const corpus = pdftotext().replace(/-\n/g, "\u0000").split(/\s+/).filter((w) => !w.includes("\u0000"));
/** A word without surrounding punctuation, in lower case. */
const bare = (w: string) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").toLowerCase();
const used = new Set(corpus.map((w) => bare(w)));
const dictionary = existsSync("/usr/share/dict/words")
  ? new Set(readFileSync("/usr/share/dict/words", "utf8").split("\n").map((w) => w.toLowerCase()))
  : new Set<string>();
const undecided = new Set<string>();
/** Every line-broken word and how it was settled, printed for review. */
const settled = new Map<string, string>();

/**
 * Joins a word broken across lines. Kept hyphenated when the text uses the hyphenated form
 * elsewhere; joined when it uses the joined form, or the joined word (or its stem) is a dictionary
 * word and the hyphenated form is not attested; otherwise HYPHEN_DECISIONS decides.
 */
function joinBrokenWord(left: string, right: string): string {
  const head = left.slice(0, -1);
  const joined = bare(head + right);
  const hyphenated = `${bare(head)}-${bare(right)}`;
  const key = `${head}-${right}`;
  const settle = (how: string, word: string) => {
    settled.set(key, `${word} (${how})`);
    return word;
  };
  const decision = HYPHEN_DECISIONS[key];
  if (decision !== undefined) return settle("decided", decision === "join" ? head + right : key);
  if (used.has(hyphenated)) return settle("hyphenated elsewhere", key);
  if (used.has(joined)) return settle("joined elsewhere", head + right);
  const stem = joined.replace(/(?:ies|es|s|ed|ing|ly|al|ally|ment|ments|ity|ities)$/, "");
  if (dictionary.has(joined) || dictionary.has(stem) || dictionary.has(`${stem}e`) || dictionary.has(`${stem}y`)) {
    return settle("dictionary", head + right);
  }
  undecided.add(key);
  return key;
}

/** Reads a cell's words, line by line, into text. */
function cellText(cell: Word[]): string {
  const lines: Word[][] = [];
  for (const word of cell.toSorted((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.at(-1);
    if (line !== undefined && Math.abs(line[0]!.y - word.y) < word.height / 2) line.push(word);
    else lines.push([word]);
  }
  let text = "";
  for (const line of lines.map((l) => l.toSorted((a, b) => a.x - b.x).map((w) => w.text))) {
    if (text === "") {
      text = line.join(" ");
    } else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(line[0]!)) {
      const last = text.slice(text.lastIndexOf(" ") + 1);
      text = `${text.slice(0, text.length - last.length)}${joinBrokenWord(last, line[0]!)}${line.length > 1 ? ` ${line.slice(1).join(" ")}` : ""}`;
    } else {
      text = `${text} ${line.join(" ")}`;
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

interface Cell {
  code: string;
  band: Band;
  text: string;
  /** The table's subject, such as "Civic and Political Institutions". */
  category: string;
  page: number;
}

/**
 * The table titles a page sets ("Dimension 2, Civic and Political Institutions"), with their
 * height on the page. A page can start a second table below the first.
 */
function tableTitles(onPage: Word[]): Array<{ y: number; category: string }> {
  const lines = new Map<number, Word[]>();
  for (const w of onPage) {
    const key = [...lines.keys()].find((y) => Math.abs(y - w.y) < w.height / 2) ?? w.y;
    lines.set(key, [...(lines.get(key) ?? []), w]);
  }
  return [...lines].map(([y, line]) => ({ y, line: line.toSorted((a, b) => a.x - b.x).map((w) => w.text) }))
    .filter(({ line }) => line[0] === "Dimension" && /^[1-4],$/.test(line[1] ?? ""))
    .map(({ y, line }) => ({ y, category: line.slice(2).join(" ") }));
}

/** Every indicator cell, from the pages that set indicator codes in columns. */
function readCells(): Cell[] {
  const cells: Cell[] = [];
  // A table that runs onto the next page keeps the title it started under.
  let carried: string | undefined;
  for (const page of new Set(words.map((w) => w.page))) {
    const onPage = words.filter((w) => w.page === page);
    const codes = onPage.filter((w) => CODE.test(w.text));
    if (codes.length === 0) continue;
    const titles = tableTitles(onPage);
    const categoryAt = (y: number) => titles.filter((t) => t.y < y).toSorted((a, b) => b.y - a.y)[0]?.category ?? carried;
    // Each band's column starts at its codes' left edge.
    const columns = BANDS.map((band) => ({ band, x: Math.min(...codes.filter((c) => c.text.endsWith(`.${band}.`)).map((c) => c.x)) }))
      .filter((c) => Number.isFinite(c.x));
    const columnOf = (w: Word) => columns.findLast((c) => w.x >= c.x - 2)?.band;
    // The page footer ("32 • C3 Framework") ends the page's table.
    const footer = Math.min(...onPage.filter((w) => w.text === "Framework" && w.y > 700).map((w) => w.y - 4));
    for (const code of codes) {
      const band = CODE.exec(code.text)![4] as Band;
      if (columnOf(code) !== band) throw new Error(`page ${page}: ${code.text} is not in its band's column`);
      const nextBelow = Math.min(
        footer,
        ...codes.filter((c) => c !== code && columnOf(c) === band && c.y > code.y + 1).map((c) => c.y - 1),
      );
      const column = onPage
        .filter((w) => w !== code && columnOf(w) === band && w.y >= code.y - 1 && w.y < nextBelow)
        .toSorted((a, b) => a.y - b.y);
      // A gap of more than two lines ends the cell: what follows is not part of the table. So does
      // the next row's placeholder ("Begins in grades 9–12"), which has no code of its own.
      const cell: Word[] = [];
      let lastY = code.y;
      for (const w of column) {
        if (w.y - lastY > 2.5 * code.height || (w.text === "Begins" && w.y > code.y + 1)) break;
        cell.push(w);
        lastY = w.y;
      }
      const category = categoryAt(code.y);
      if (category === undefined) throw new Error(`page ${page}: ${code.text} comes before any table title`);
      cells.push({ code: code.text.slice(0, -1), band, text: cellText(cell), category, page });
    }
    carried = categoryAt(Number.POSITIVE_INFINITY);
  }
  return cells;
}

const DIMENSIONS: Readonly<Record<string, string>> = {
  "1": "Developing Questions and Planning Inquiries",
  "2": "Applying Disciplinary Tools and Concepts",
  "3": "Evaluating Sources and Using Evidence",
  "4": "Communicating Conclusions and Taking Informed Action",
};
const DISCIPLINES: Readonly<Record<string, string>> = { Civ: "Civics", Eco: "Economics", Geo: "Geography", His: "History" };

const reference = wordKey(pdftotext());
const rows = readCells()
  .filter((cell) => !cell.text.startsWith("Begins in grades") && cell.text !== "")
  .map((cell) => {
    const [, dimension, discipline, number] = CODE.exec(`${cell.code}.`)!;
    // The cell must match whole: what follows it in the reading order starts a new sentence (the
    // next code, a placeholder or the page footer), not the rest of a cell that was cut short.
    const key = wordKey(`${cell.code}. ${cell.text}`);
    const at = reference.indexOf(key);
    const verified = at !== -1 && /^[\p{Lu}\p{N}]/u.test(reference.slice(at + key.length));
    return {
      code: cell.code,
      dimension: `Dimension ${dimension}: ${DIMENSIONS[dimension!]}`,
      discipline: discipline === undefined ? null : DISCIPLINES[discipline]!,
      category: cell.category,
      indicator: `D${dimension}.${discipline === undefined ? "" : `${discipline}.`}${number}`,
      band: cell.band,
      educationLevels: LEVELS[cell.band],
      statement: verified ? cell.text : null,
      textCheck: verified ? "verified-against-reading-order" : "not-in-reading-order",
      page: cell.page,
    };
  });
if (undecided.size > 0) {
  throw new Error(`settle these line-broken words in HYPHEN_DECISIONS: ${[...undecided].toSorted().join(", ")}`);
}
const duplicates = rows.filter((r, i) => rows.findIndex((o) => o.code === r.code) !== i);
if (duplicates.length > 0) throw new Error(`indicators read twice: ${duplicates.map((r) => r.code).join(", ")}`);

const header = {
  // NCSS asks that reproductions carry this citation.
  citation: C3_CITATION,
  source: { pdf: C3_PDF, retrievedOn: new Date().toLocaleDateString("en-CA") },
};
const json = `${JSON.stringify(header).slice(0, -1)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
writeFileSync(new URL("../src/publisher/c3-rows.json", import.meta.url), json);
const counts = Object.groupBy(rows, (r) => r.textCheck);
console.log(rows.length, Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v?.length])));
for (const row of rows.filter((r) => r.statement === null)) console.log("not in reading order:", row.code);
for (const [broken, how] of [...settled].toSorted()) console.log(`line break ${broken} -> ${how}`);
