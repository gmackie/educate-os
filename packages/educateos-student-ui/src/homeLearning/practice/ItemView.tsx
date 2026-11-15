import type { Answer } from "@educateos/home-learning/scoring";
import { BuildWordItem } from "./BuildWordItem.tsx";
import { ChoiceItem } from "./ChoiceItem.tsx";
import { CompareItem } from "./CompareItem.tsx";
import { CountSoundsItem } from "./CountSoundsItem.tsx";
import { NumberChoiceItem } from "./NumberChoiceItem.tsx";
import { NumberLineItem } from "./NumberLineItem.tsx";
import { ReadAloudItem } from "./ReadAloudItem.tsx";
import type { Item } from "./types.ts";

/** The answering part of an item, by its type. */
export const ItemView = ({ item, disabled, onAnswer }: { item: Item; disabled: boolean; onAnswer: (answer: Answer) => void }) => {
  switch (item.type) {
    case "count-sounds": return <CountSoundsItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    case "build-word": return <BuildWordItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    case "count-objects": case "one-more-less": return <NumberChoiceItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    case "compare-groups": return <CompareItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    case "place-on-line": case "number-line-jump": return <NumberLineItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    case "read-aloud": return <ReadAloudItem item={item} disabled={disabled} onAnswer={onAnswer} />;
    default: return <ChoiceItem item={item} disabled={disabled} onAnswer={onAnswer} />;
  }
};
