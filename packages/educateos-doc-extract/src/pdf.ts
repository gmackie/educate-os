import { type StepBudget, ExtractionStopped, TextSink } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

/**
 * Stream dictionaries that never hold page text: images, fonts, metadata, attachments and the
 * file's own cross-reference streams. They are skipped without being inflated.
 */
const NOT_TEXT = /\/(?:Subtype\s*\/(?:Image|Type1C|CIDFontType0C|OpenType)|Type\s*\/(?:XRef|Metadata|EmbeddedFile)|Length[123]\b)/;
const OBJECT_STREAM = /\/Type\s*\/ObjStm\b/;
const PAGE = /\/Type\s*\/Page(?![A-Za-z])/g;
const MAX_DICTIONARY = 64 * 1024;

/**
 * Extracts the text a PDF's content streams draw, for review. It reads only what it can read
 * exactly, and refuses the rest rather than guessing:
 *
 * - Streams that are uncompressed or Flate-compressed (with no predictor) are read. Any other
 *   filter is skipped, and a document whose text is all behind one is `unsupported-encoding`.
 * - Text is shown by `Tj`, `TJ`, `'` and `"` inside `BT … ET`. Strings are decoded as UTF-16BE when
 *   marked so and as Latin-1 otherwise. Text drawn through fonts with their own encodings (CID and
 *   Identity-H fonts, most subsetted fonts) does not decode to readable characters, so a result
 *   that is mostly unreadable is refused as `unsupported-encoding` rather than returned.
 * - An encrypted document is `encrypted`; one declaring more than `maxPages` pages is
 *   `too-many-pages`; inflating more than `maxInflatedBytes` is `too-large`.
 *
 * @throws ExtractionStopped with the reason it could not be read.
 */
export async function extractPdfText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  // Latin-1 maps each byte to one code unit, so offsets in the string are offsets in the file.
  const source = new TextDecoder("latin1").decode(bytes);
  budget.spend(bytes.byteLength / 64);
  if (!source.startsWith("%PDF-")) throw new ExtractionStopped("malformed");
  if (/\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(source)) throw new ExtractionStopped("encrypted");
  let pages = countPages(source);
  if (pages > limits.maxPages) throw new ExtractionStopped("too-many-pages");

  const sink = new TextSink(limits.maxTextChars);
  let inflatedTotal = 0;
  let textStreams = 0;
  let unsupportedStreams = 0;
  for (const stream of streams(source, budget)) {
    if (sink.full) break;
    if (NOT_TEXT.test(stream.dictionary)) continue;
    const filters = filtersOf(stream.dictionary);
    let content: string;
    if (filters === undefined) {
      unsupportedStreams++;
      continue;
    }
    if (filters.length === 0) {
      content = source.slice(stream.start, stream.end);
    } else {
      const inflated = await inflate(bytes.subarray(stream.start, stream.end), limits.maxInflatedBytes - inflatedTotal);
      if (inflated === undefined) {
        unsupportedStreams++;
        continue;
      }
      inflatedTotal += inflated.byteLength;
      budget.spend(inflated.byteLength / 64);
      content = new TextDecoder("latin1").decode(inflated);
    }
    if (OBJECT_STREAM.test(stream.dictionary)) {
      // Page objects may be packed inside object streams, out of sight of the first count.
      pages += countPages(content);
      if (pages > limits.maxPages) throw new ExtractionStopped("too-many-pages");
      continue;
    }
    if (!/\bBT\b/.test(content)) continue;
    textStreams++;
    showText(content, sink, budget);
    sink.newline();
  }

  const raw = sink.text();
  if (raw !== "" && !readable(raw)) throw new ExtractionStopped("unsupported-encoding");
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const text = raw.replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/g, "").trim();
  if (text === "") throw new ExtractionStopped(unsupportedStreams > 0 && textStreams === 0 ? "unsupported-encoding" : "no-text");
  return { text, truncated: sink.truncated };
}

function countPages(text: string): number {
  return text.match(PAGE)?.length ?? 0;
}

/** One stream: its dictionary's source and where its data lies in the file. */
interface StreamSpan {
  dictionary: string;
  start: number;
  end: number;
}

/**
 * The streams of a PDF in file order, found by scanning for object headers. Scanning resumes after
 * each stream's data, so bytes inside a stream are never mistaken for structure.
 */
function* streams(source: string, budget: StepBudget): Generator<StreamSpan> {
  // Local, because a generator suspends: a shared global regex's position would be shared too.
  const objectHeader = /\d+\s+\d+\s+obj\b/g;
  for (let header = objectHeader.exec(source); header !== null; header = objectHeader.exec(source)) {
    budget.spend(16);
    let at = skipWhitespace(source, objectHeader.lastIndex);
    if (!source.startsWith("<<", at)) continue;
    const dictionaryEnd = endOfDictionary(source, at, budget);
    if (dictionaryEnd === undefined) continue;
    const dictionary = source.slice(at, dictionaryEnd);
    at = skipWhitespace(source, dictionaryEnd);
    if (!source.startsWith("stream", at)) continue;
    at += "stream".length;
    if (source.startsWith("\r\n", at)) at += 2;
    else if (source[at] === "\n" || source[at] === "\r") at += 1;
    else continue;
    const start = at;
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary);
    let end: number;
    const length = declared === null ? undefined : Number(declared[1]);
    if (length !== undefined && start + length <= source.length && /^\s*endstream/.test(source.slice(start + length, start + length + 16))) {
      end = start + length;
    } else {
      const marker = source.indexOf("endstream", start);
      if (marker < 0) return;
      end = marker;
      // The line ending before `endstream` is not data.
      if (source[end - 1] === "\n") end--;
      if (source[end - 1] === "\r") end--;
    }
    yield { dictionary, start, end };
    objectHeader.lastIndex = end;
  }
}

function skipWhitespace(source: string, at: number): number {
  while (at < source.length && /[\0\t\n\f\r ]/.test(source[at]!)) at++;
  return at;
}

/** The offset just past the `>>` closing the dictionary opening at `at`, skipping strings. */
function endOfDictionary(source: string, at: number, budget: StepBudget): number | undefined {
  let depth = 0;
  const limit = Math.min(source.length, at + MAX_DICTIONARY);
  for (let i = at; i < limit; i++) {
    budget.spend();
    const char = source[i];
    if (char === "(") {
      const string = readLiteral(source, i, budget);
      i = string.next - 1;
    } else if (char === "<" && source[i + 1] === "<") {
      depth++;
      i++;
    } else if (char === ">" && source[i + 1] === ">") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/**
 * A stream's filters, in order: an empty list for none, or undefined when any is not Flate or a
 * predictor is set, neither of which this extractor decodes.
 */
function filtersOf(dictionary: string): string[] | undefined {
  const value = /\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/.exec(dictionary)?.[1];
  const names = value === undefined ? [] : [...value.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1]!);
  if (names.length > 1 || names.some((name) => name !== "FlateDecode" && name !== "Fl")) return undefined;
  const predictor = /\/Predictor\s+(\d+)/.exec(dictionary)?.[1];
  if (predictor !== undefined && Number(predictor) > 1) return undefined;
  return names;
}

/**
 * Inflates zlib data, producing at most `maxBytes`. Returns undefined for data that is not valid
 * zlib from the start; data that is valid but followed by junk keeps what inflated before it.
 *
 * @throws ExtractionStopped `too-large` once the output passes `maxBytes`.
 */
async function inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array | undefined> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ExtractionStopped("too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExtractionStopped) throw error;
    if (chunks.length === 0) return undefined;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** An operand on a content stream's stack. Only what the text operators read is kept. */
type Operand = { kind: "string"; bytes: string } | { kind: "number"; value: number } | { kind: "array"; items: Operand[] } | { kind: "other" };

const DELIMITERS = "()<>[]{}/%";
const isWhitespace = (char: string | undefined) => char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\0";
const isRegular = (char: string | undefined) => char !== undefined && !isWhitespace(char) && !DELIMITERS.includes(char);

/** A TJ adjustment this far left (in thousandths of a text unit) is a gap between words. */
const WORD_GAP = -200;

/** Interprets a content stream's text operators, writing what they show to `sink`. */
function showText(content: string, sink: TextSink, budget: StepBudget): void {
  const operands: Operand[] = [];
  const arrays: Operand[][] = [];
  let inText = false;
  const push = (operand: Operand) => (arrays.at(-1) ?? operands).push(operand);
  const show = (operand: Operand | undefined) => {
    if (operand?.kind === "string") sink.write(decodePdfString(operand.bytes));
  };

  let i = 0;
  while (i < content.length && !sink.full) {
    budget.spend();
    const char = content[i]!;
    if (isWhitespace(char)) {
      i++;
    } else if (char === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i++;
    } else if (char === "(") {
      const string = readLiteral(content, i, budget);
      push({ kind: "string", bytes: string.value });
      i = string.next;
    } else if (char === "<" && content[i + 1] === "<") {
      i += 2;
    } else if (char === ">" && content[i + 1] === ">") {
      i += 2;
    } else if (char === "<") {
      const end = content.indexOf(">", i);
      if (end < 0) return;
      push({ kind: "string", bytes: decodeHex(content.slice(i + 1, end)) });
      budget.spend(end - i);
      i = end + 1;
    } else if (char === "[") {
      arrays.push([]);
      i++;
    } else if (char === "]") {
      const items = arrays.pop() ?? [];
      push({ kind: "array", items });
      i++;
    } else if (char === "/") {
      i++;
      while (isRegular(content[i])) i++;
      push({ kind: "other" });
    } else if (/[0-9+\-.]/.test(char)) {
      const start = i;
      i++;
      while (/[0-9.]/.test(content[i] ?? "")) i++;
      push({ kind: "number", value: Number(content.slice(start, i)) || 0 });
    } else if (isRegular(char)) {
      const start = i;
      while (isRegular(content[i])) i++;
      const operator = content.slice(start, i);
      if (operator === "BI") {
        // An inline image's data is binary: skip to its end marker.
        const end = content.slice(i).search(/\sEI(?![^\s/[<(])/);
        if (end < 0) return;
        i += end + 3;
      } else if (operator === "BT") {
        inText = true;
      } else if (operator === "ET") {
        inText = false;
        sink.newline();
      } else if (inText) {
        const top = operands.at(-1);
        switch (operator) {
          case "Tj":
            show(top);
            break;
          case "'":
            sink.newline();
            show(top);
            break;
          case "\"":
            sink.newline();
            show(top);
            break;
          case "TJ":
            if (top?.kind === "array") {
              for (const item of top.items) {
                if (item.kind === "number" && item.value < WORD_GAP) sink.write(" ");
                else show(item);
              }
            }
            break;
          case "T*":
            sink.newline();
            break;
          case "Td":
          case "TD": {
            const ty = operands.at(-1);
            if (ty?.kind === "number" && ty.value !== 0) sink.newline();
            else sink.write(" ");
            break;
          }
          case "Tm":
            sink.newline();
            break;
        }
      }
      operands.length = 0;
      arrays.length = 0;
    } else {
      i++;
    }
  }
}

/** Reads the literal string opening at `at`: balanced parentheses, escapes and octal codes. */
function readLiteral(source: string, at: number, budget: StepBudget): { value: string; next: number } {
  let depth = 0;
  let value = "";
  let i = at;
  for (; i < source.length; i++) {
    budget.spend();
    const char = source[i]!;
    if (char === "\\") {
      const next = source[i + 1];
      i++;
      if (next === undefined) break;
      const escaped: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (escaped[next] !== undefined) value += escaped[next];
      else if (/[0-7]/.test(next)) {
        const octal = /^[0-7]{1,3}/.exec(source.slice(i, i + 3))![0];
        value += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        i += octal.length - 1;
      } else if (next === "\r") {
        if (source[i + 1] === "\n") i++;
      } else if (next !== "\n") {
        value += next;
      }
      continue;
    }
    if (char === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return { value, next: i + 1 };
    }
    value += char;
  }
  return { value, next: i };
}

function decodeHex(hex: string): string {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  let value = "";
  for (let i = 0; i < padded.length; i += 2) value += String.fromCharCode(Number.parseInt(padded.slice(i, i + 2), 16));
  return value;
}

/** A PDF string's bytes as text: UTF-16BE behind its byte-order mark, otherwise Latin-1. */
function decodePdfString(bytes: string): string {
  if (bytes.startsWith("þÿ")) {
    const units = Uint8Array.from(bytes.slice(2), (char) => char.charCodeAt(0));
    return new TextDecoder("utf-16be").decode(units);
  }
  return bytes;
}

/**
 * Whether extracted text reads as text: nearly all of its visible characters are letters, digits,
 * punctuation or symbols, and at least half are letters or digits. Two-byte glyph IDs read through
 * the wrong encoding come out as control codes and stray Latin-1, which fails this.
 */
function readable(text: string): boolean {
  const visible = text.replace(/[\t\n\r ]/g, "");
  if (visible.length === 0) return false;
  const ordinary = visible.match(/[\p{L}\p{N}\p{P}\p{S}]/gu)?.length ?? 0;
  const letters = visible.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return ordinary / visible.length >= 0.9 && letters / visible.length >= 0.5;
}
