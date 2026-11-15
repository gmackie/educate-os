import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { BIG, type ItemProps } from "./types.ts";
import { speak } from "./speak.ts";

/** Hear a word and build it from letter tiles, each tile used once. */
export const BuildWordItem = ({ item, disabled, onAnswer }: ItemProps<"build-word">) => {
  const [used, setUsed] = useState<number[]>([]);
  const built = used.map((index) => item.tiles[index]!);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        {item.picture === undefined ? null : <span role="img" aria-label={item.picture.label} className="text-6xl">{item.picture.emoji}</span>}
        <Button size="lg" icon={<SpeakerHighIcon aria-hidden />} onClick={() => speak(item.word)}>Hear the word</Button>
      </div>
      <p aria-live="polite" className="flex min-h-20 items-center gap-2 text-5xl font-bold tracking-wider">
        {built.length === 0 ? <span className="text-xl font-normal text-kumo-subtle">Tap letters to build the word.</span> : built.join("")}
      </p>
      <ul className="flex flex-wrap gap-3" aria-label="Letter tiles">
        {item.tiles.map((tile, index) => (
          <li key={index}>
            <Button className={`${BIG} text-3xl`} disabled={disabled || used.includes(index)} onClick={() => setUsed((u) => [...u, index])}>{tile}</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button className={BIG} icon={<ArrowCounterClockwiseIcon aria-hidden />} disabled={disabled || used.length === 0} onClick={() => setUsed((u) => u.slice(0, -1))}>Undo</Button>
        <Button className={BIG} variant="primary" disabled={disabled || used.length === 0} onClick={() => onAnswer({ kind: "letters", letters: built })}>Done</Button>
      </div>
    </div>
  );
};
