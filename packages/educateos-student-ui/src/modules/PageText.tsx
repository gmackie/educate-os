import { Fragment, type ReactNode } from "react";
import { SafeExternalLink } from "../SafeExternalLink.tsx";

/** A heading level inside a page, below the page's own title. */
type HeadingLevel = 4 | 5 | 6;

type Block =
  | { kind: "heading"; level: HeadingLevel; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/** Splits a page's Markdown into headings, lists and paragraphs. */
export const pageBlocks = (markdown: string): Block[] => {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);
    if (line === "") {
      flush();
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
      }
    })}
  </div>
);
