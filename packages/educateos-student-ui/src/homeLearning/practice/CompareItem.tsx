import { Button } from "@cloudflare/kumo";
import { type ItemProps } from "./types.ts";

/** Two groups; tap the one with more, or fewer. */
export const CompareItem = ({ item, disabled, onAnswer }: ItemProps<"compare-groups">) => (
  <div className="grid grid-cols-2 gap-4">
    {(["left", "right"] as const).map((side) => {
      const count = item[side];
      return (
        <Button
          key={side}
          className="h-auto min-h-40 flex-wrap content-center gap-2 p-4 text-4xl"
          disabled={disabled}
          aria-label={`${side === "left" ? "Left" : "Right"} group: ${count} ${item.picture.label}`}
          onClick={() => onAnswer({ kind: "choice", choice: side })}
        >
          {Array.from({ length: count }, (_, index) => <span key={index} aria-hidden>{item.picture.emoji}</span>)}
        </Button>
      );
    })}
  </div>
);
