/**
 * The Markdown teachers write in pages, prompts and posts, drawn natively: headings, paragraphs,
 * bullet and numbered lists, simple pipe tables, **bold**, *italic*, `code` and [links](…). A link
 * is tappable only when its address is plain `https` (see `safeLink`); any other address is dropped
 * and its text shown. Anything else is shown as written. Never renders HTML.
 */
import { safeLink } from './modules.ts';

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] };

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

/** The cells of a `| a | b |` row, or null if the line is not one. */
function cells(line: string): string[] | null {
  if (!line.startsWith('|') || line.length < 2) return null;
  const inner = line.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}
const isDivider = (row: string[]) => row.length > 0 && row.every((cell) => /^:?-{1,}:?$/.test(cell));

/** The most columns and rows a table draws; larger tables are rare in teacher text and unreadable on a phone. */
const MAX_COLUMNS = 8, MAX_ROWS = 60;

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const lines = source.replace(/\r\n?/g, '\n').split('\n').map((raw) => raw.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const header = cells(line);
    const divider = header ? cells(lines[i + 1] ?? '') : null;
    if (line === '') { flush(); continue; }
    if (header && divider && isDivider(divider) && header.length <= MAX_COLUMNS) {
      // A table: a header row, a |---| divider, then rows until a line that is not a row.
      flush();
      const rows: string[][] = [];
      i += 1;
      while (i + 1 < lines.length && cells(lines[i + 1]!) && rows.length < MAX_ROWS) {
        const row = cells(lines[++i]!)!;
        rows.push(header.map((_, n) => row[n] ?? ''));
      }
      blocks.push({ kind: 'table', header, rows });
    } else if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, text: heading[2]! });
    } else if (bullet || numbered) {
      flush();
      const ordered = !!numbered;
      const last = blocks.at(-1);
      const text = (bullet ?? numbered)![1]!;
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(text);
      else blocks.push({ kind: 'list', ordered, items: [text] });
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

export function parseSpans(text: string): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]*)\)/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index) spans.push({ text: text.slice(index, match.index) });
    const [, bold, bold2, italic, italic2, code, link, address] = match;
    if (bold ?? bold2) spans.push({ text: (bold ?? bold2)!, bold: true });
    else if (italic ?? italic2) spans.push({ text: (italic ?? italic2)!, italic: true });
    else if (code) spans.push({ text: code, code: true });
    else {
      const href = safeLink(address ?? '');
      spans.push(href ? { text: link!, href } : { text: link! });
    }
    index = match.index + match[0].length;
  }
  if (index < text.length) spans.push({ text: text.slice(index) });
  return spans;
}

/** Markdown as one plain line, for list rows, previews and reading aloud. */
export function plainText(source: string): string {
  return parseBlocks(source).map((b) => b.kind === 'list' ? b.items.join(', ')
    : b.kind === 'table' ? [b.header, ...b.rows].map((row) => row.join(', ')).join('. ') : b.text)
    .map((t) => parseSpans(t).map((s) => s.text).join('')).join(' ');
}
