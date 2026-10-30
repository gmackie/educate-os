/**
 * The Markdown teachers write in pages, prompts and posts, drawn natively: headings, paragraphs,
 * bullet and numbered lists, **bold**, *italic*, `code` and [links](…), whose text is shown and
 * whose address is not followed. Anything else is shown as written. Never renders HTML.
 */
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (line === '') { flush(); continue; }
    if (heading) {
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
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\[([^\]]+)\]\([^)]*\)/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index) spans.push({ text: text.slice(index, match.index) });
    const [, bold, bold2, italic, italic2, code, link] = match;
    if (bold ?? bold2) spans.push({ text: (bold ?? bold2)!, bold: true });
    else if (italic ?? italic2) spans.push({ text: (italic ?? italic2)!, italic: true });
    else if (code) spans.push({ text: code, code: true });
    else spans.push({ text: link! });
    index = match.index + match[0].length;
  }
  if (index < text.length) spans.push({ text: text.slice(index) });
  return spans;
}

/** Markdown as one plain line, for list rows and previews. */
export function plainText(source: string): string {
  return parseBlocks(source).map((b) => b.kind === 'list' ? b.items.join(', ') : b.text)
    .map((t) => parseSpans(t).map((s) => s.text).join('')).join(' ');
}
