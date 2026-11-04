import { Fragment, type ReactNode } from "react";
import { SafeExternalLink } from "../SafeExternalLink.tsx";

/** A heading level inside a page, below the page's own title. */
type HeadingLevel = 4 | 5 | 6;

/** A table column's alignment, from its delimiter row (`:--`, `:-:`, `--:`). */
type Align = "left" | "center" | "right" | undefined;

type Block =
  | { kind: "heading"; level: HeadingLevel; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string }
  | { kind: "table"; header: string[]; align: Align[]; rows: string[][] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const DELIMITER_CELL = /^:?-+:?$/;

/** A GFM table row's cells: the outer pipes are optional and `\|` is a literal pipe. */
const tableCells = (line: string): string[] => {
  const inner = line.replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
};

/** The column alignments of a GFM delimiter row, or `null` when the line is not one. */
const delimiterRow = (line: string): Align[] | null => {
  if (!line.includes("-") || !line.includes("|")) return null;
  const cells = tableCells(line);
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined);
};

/** Splits a page's Markdown into headings, lists, GFM tables and paragraphs. */
export const pageBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const lines = markdown.split(/\r?\n/).map((raw) => raw.trim());
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    const align = line.includes("|") && at + 1 < lines.length ? delimiterRow(lines[at + 1]!) : null;
    if (line === "") {
      flush();
    } else if (align !== null && tableCells(line).length === align.length) {
      flush();
      const header = tableCells(line);
      const rows: string[][] = [];
      // Body rows run until a blank line or a line with no pipe; each is padded or cut to the
      // header's width, as GFM does.
      for (at += 2; at < lines.length && lines[at] !== "" && lines[at]!.includes("|"); at++) {
        const cells = tableCells(lines[at]!);
        rows.push(header.map((_, column) => cells[column] ?? ""));
      }
      at--;
      blocks.push({ kind: "table", header, align, rows });
    } else if (heading !== null) {
      flush();
      blocks.push({ kind: "heading", level: (3 + heading[1]!.length) as HeadingLevel, text: heading[2]! });
    } else if (bullet !== null || numbered !== null) {
      flush();
      const ordered = numbered !== null;
      const last = blocks.at(-1);
      const item = (bullet ?? numbered)![1]!;
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
};

// Bold, italics, inline code, links and bare `https` addresses, in that order of precedence.
// Anything else is text. A bare address stops before trailing punctuation, so "see https://a.example."
// links to the address, not the full stop.
const INLINE = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[([^\]]+)\]\(([^)\s]+)\)|(https:\/\/[^\s<>"]*[^\s<>".,;:!?'")\]])/g;

/** One line of Markdown as text with emphasis and links. Only `https` addresses become links. */
const Inline = ({ text }: { text: string }) => {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    const [, bold, italic, code, label, href, bare] = match;
    if (bold !== undefined) parts.push(<strong>{bold}</strong>);
    else if (italic !== undefined) parts.push(<em>{italic}</em>);
    else if (code !== undefined) parts.push(<code>{code}</code>);
    else if (bare !== undefined) parts.push(<SafeExternalLink href={bare}>{bare}</SafeExternalLink>);
    else parts.push(<SafeExternalLink href={href!}>{label}</SafeExternalLink>);
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts.map((part, i) => <Fragment key={i}>{part}</Fragment>)}</>;
};

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * A GFM table. It scrolls sideways on its own on a narrow screen rather than widening the page. When
 * the header's first cell is empty (a Punnett square, a times table), the first column labels its
 * row, so each body row's first cell is a row header for screen readers.
 */
const PageTable = ({ table }: { table: Extract<Block, { kind: "table" }> }) => {
  const rowHeaders = table.header[0] === "";
  const cell = (column: number) => {
    const align = table.align[column];
    return `border border-kumo-hairline px-3 py-1.5 ${align === undefined ? "text-left" : ALIGN[align]}`;
  };
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="border-collapse text-sm">
        <thead>
          <tr>
            {table.header.map((text, column) => (
              rowHeaders && column === 0
                ? <td key={column} className={cell(column)} />
                : <th key={column} scope="col" className={`${cell(column)} font-semibold`}><Inline text={text} /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.map((text, column) => (
                rowHeaders && column === 0
                  ? <th key={column} scope="row" className={`${cell(column)} font-semibold`}><Inline text={text} /></th>
                  : <td key={column} className={cell(column)}><Inline text={text} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * A page a teacher wrote, rendered from its Markdown as React elements only, never as HTML: a
 * page's text cannot add markup, scripts or styles to the Learning Home, and links open outside it
 * through {@link SafeExternalLink}.
 */
export const PageText = ({ markdown }: { markdown: string }) => (
  <div className="flex flex-col gap-3">
    {pageBlocks(markdown).map((block, i) => {
      switch (block.kind) {
        case "heading": {
          const Heading = `h${block.level}` as const;
          return <Heading key={i} className="font-semibold"><Inline text={block.text} /></Heading>;
        }
        case "list": {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} className={`flex flex-col gap-1 pl-6 ${block.ordered ? "list-decimal" : "list-disc"}`}>
              {block.items.map((item, j) => <li key={j}><Inline text={item} /></li>)}
            </List>
          );
        }
        case "paragraph":
          return <p key={i}><Inline text={block.text} /></p>;
        case "table":
          return <PageTable key={i} table={block} />;
      }
    })}
  </div>
);
