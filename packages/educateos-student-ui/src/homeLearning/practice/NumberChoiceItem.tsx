import { Button } from "@cloudflare/kumo";
import { BIG, type ItemProps } from "./types.ts";

/** Count pictured objects, or dots for one more and one less, then tap a number. */
export const NumberChoiceItem = ({ item, disabled, onAnswer }: ItemProps<"count-objects" | "one-more-less">) => {
  const shown = item.type === "count-objects" ? { emoji: item.picture.emoji, count: item.count, label: item.picture.label } : { emoji: "🔵", count: item.start, label: "dots" };
  return (
    <div className="flex flex-col gap-6">
      {shown.count === 0 ? (
        <p className="min-h-20 rounded-xl border-2 border-dashed border-kumo-hairline p-6 text-xl text-kumo-subtle">The tray is empty.</p>
      ) : (
        <ul aria-label={`${shown.label} to count`} className="grid max-w-md grid-cols-5 gap-3 text-5xl">
          {Array.from({ length: shown.count }, (_, index) => <li key={index} aria-label="one" role="img">{shown.emoji}</li>)}
        </ul>
      )}
      <ul className="flex flex-wrap gap-4" aria-label="Numbers">
        {item.choices.map((n) => (
          <li key={n}>
            <Button className={`${BIG} text-3xl`} disabled={disabled} onClick={() => onAnswer({ kind: "number", value: n })}>{String(n)}</Button>
          </li>
        ))}
      </ul>
    </div>
  );
};
