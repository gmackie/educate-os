import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { MinusIcon, PlusIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { BIG, type ItemProps } from "./types.ts";
import { speak } from "./speak.ts";

const MAX_COUNTERS = 6;

/** Hear a word and put down one counter for each sound. */
export const CountSoundsItem = ({ item, disabled, onAnswer }: ItemProps<"count-sounds">) => {
  const [counters, setCounters] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <span role="img" aria-label={item.picture.label} className="text-6xl">{item.picture.emoji}</span>
        <Button size="lg" icon={<SpeakerHighIcon aria-hidden />} onClick={() => speak(item.word)}>Hear the word</Button>
      </div>
      <div className="flex min-h-20 items-center gap-3" aria-live="polite">
        <ol aria-hidden className="flex gap-3">
          {Array.from({ length: counters }, (_, index) => <li key={index} className="size-14 rounded-full border-4 border-kumo-hairline bg-kumo-tint" />)}
        </ol>
        <span className="sr-only">{counters === 1 ? "1 counter" : `${counters} counters`}</span>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button className={BIG} variant="primary" icon={<PlusIcon aria-hidden />} disabled={disabled || counters >= MAX_COUNTERS} onClick={() => setCounters((n) => n + 1)}>Add a counter</Button>
        <Button className={BIG} icon={<MinusIcon aria-hidden />} disabled={disabled || counters === 0} onClick={() => setCounters((n) => n - 1)}>Take one away</Button>
        <Button className={BIG} disabled={disabled || counters === 0} onClick={() => onAnswer({ kind: "number", value: counters })}>Done</Button>
      </div>
    </div>
  );
};
