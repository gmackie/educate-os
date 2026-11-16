import type { ReadAloudControl } from "./useReadAloud.ts";

/**
 * Text that can be read aloud, highlighted while it is: the whole passage, and the word being
 * spoken when the browser reports one, so a young reader can follow along. Line breaks are kept.
 */
export const SpokenText = ({ control, className }: { control: ReadAloudControl; className?: string }) => {
  const { text, reading, word } = control;
  const classes = `whitespace-pre-line rounded ${reading ? "bg-kumo-info-tint" : ""} ${className ?? ""}`.trim();
  if (!reading || word === undefined) return <p className={classes}>{text}</p>;
  return (
    <p className={classes}>
      {text.slice(0, word.start)}
      <mark className="rounded bg-kumo-warning-tint text-kumo-default">{text.slice(word.start, word.end)}</mark>
      {text.slice(word.end)}
    </p>
  );
};
