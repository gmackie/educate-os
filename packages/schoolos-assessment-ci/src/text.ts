// Metered text helpers for evaluators. Offsets are UTF-16 code units of the canonical text.
import type { EvaluationKit, TextRange } from "./sdk.ts";

/** One line of text, without its line break. */
export interface Line {
  text: string;
  start: number;
  end: number;
}

/** A Markdown ATX heading (`## Methods`) and the body that follows it up to the next heading at its level or above. */
export interface Section {
  title: string;
  level: number;
  /** The heading line. */
  heading: TextRange;
  /** From the end of the heading line to the end of the section; empty when `start === end`. */
  body: { start: number; end: number };
}

/** The lines of `text`, spending a step for each. */
export function lines(text: string, kit: EvaluationKit): Line[] {
  const result: Line[] = [];
  let start = 0;
  for (;;) {
    kit.step();
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    result.push({ text: text.slice(start, end), start, end });
    if (newline === -1) return result;
    start = newline + 1;
  }
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** The Markdown sections of `text`, in order. */
export function sections(text: string, kit: EvaluationKit): Section[] {
  const headings: { title: string; level: number; line: Line }[] = [];
  for (const line of lines(text, kit)) {
    const match = HEADING.exec(line.text);
    if (match !== null && line.end > line.start) headings.push({ title: match[2]!, level: match[1]!.length, line });
  }
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((later) => later.level <= h.level);
    const bodyStart = Math.min(h.line.end + 1, text.length);
    return {
      title: h.title,
      level: h.level,
      heading: { start: h.line.start, end: h.line.end },
      body: { start: bodyStart, end: Math.max(bodyStart, next === undefined ? text.length : next.line.start) },
    };
  });
}

/** A heading or column title compared loosely: case, surrounding space, runs of space and a trailing colon ignored. */
export function looseTitle(title: string): string {
  return title.trim().replace(/:$/, "").replace(/\s+/g, " ").toLowerCase();
}

/** The section titled `title`, compared with {@link looseTitle}. */
export function findSection(all: readonly Section[], title: string): Section | undefined {
  return all.find((s) => looseTitle(s.title) === looseTitle(title));
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** The words in `text` between `start` and `end`, spending a step for each. Markdown heading lines are not counted. */
export function countWords(text: string, range: { start: number; end: number }, kit: EvaluationKit): number {
  let count = 0;
  for (const line of lines(text.slice(range.start, range.end), kit)) {
    if (HEADING.test(line.text)) continue;
    for (const _word of line.text.matchAll(WORD)) {
      kit.step();
      count += 1;
    }
  }
  return count;
}

/** The first case-insensitive occurrence of `phrase` in `text` within `range`, any run of whitespace matching any other. */
export function findPhrase(text: string, phrase: string, range: { start: number; end: number }, kit: EvaluationKit): TextRange | undefined {
  // The phrase is escaped into a literal pattern, so a teacher's config can never supply a regular expression.
  const source = phrase.trim().split(/\s+/).map((part) => part.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("\\s+");
  kit.step(Math.ceil((range.end - range.start) / 64) + 1);
  const pattern = new RegExp(source, "giu");
  pattern.lastIndex = range.start;
  const match = pattern.exec(text);
  if (match === null || match.index + match[0].length > range.end) return undefined;
  return { start: match.index, end: match.index + match[0].length };
}
