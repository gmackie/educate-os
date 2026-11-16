import { Button } from "@cloudflare/kumo";
import { BIG, type ItemOf, type ItemProps } from "./types.ts";
import { HearButton } from "./HearButton.tsx";

type ChoiceType = "blend-sounds" | "read-word" | "find-word" | "read-sentence" | "listen-and-answer";

/** What the child reads, hears or is told before choosing. A word or sentence to read is never spoken. */
const Stimulus = ({ item }: { item: ItemOf<ChoiceType> }) => {
  switch (item.type) {
    case "blend-sounds":
      return (
        <div className="rounded-xl border border-kumo-hairline p-4">
          <p className="text-base text-kumo-subtle">Grown-up, say these sounds with a short pause between them:</p>
          <p className="text-3xl font-semibold tracking-wide">{item.phonemes.join("  ")}</p>
        </div>
      );
    case "read-word":
      return <p lang="en" className="text-6xl font-bold tracking-wider">{item.word}</p>;
    case "read-sentence":
      return <p lang="en" className="text-4xl font-semibold leading-snug">{item.sentence}</p>;
    case "find-word":
      return (
        <HearButton size="lg" text={item.word} sayInstead={item.word}>Hear the word</HearButton>
      );
    case "listen-and-answer":
      return (
        <div className="flex flex-col items-start gap-3">
          <HearButton size="lg" text={item.passage} sayInstead={item.passage}>Hear the story</HearButton>
          <p className="text-2xl">{item.question}</p>
          <HearButton variant="ghost" text={item.question}>Hear the question</HearButton>
        </div>
      );
  }
};

/** A choice among pictures or printed words. */
export const ChoiceItem = ({ item, disabled, onAnswer }: ItemProps<ChoiceType>) => (
  <div className="flex flex-col gap-6">
    <Stimulus item={item} />
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-label="Choices">
      {item.choices.map((choice) => (
        <li key={choice.key}>
          <Button
            className={`${BIG} h-auto w-full flex-col py-4`}
            disabled={disabled}
            aria-label={choice.picture?.label ?? choice.text}
            onClick={() => onAnswer({ kind: "choice", choice: choice.key })}
          >
            {choice.picture === undefined ? null : <span aria-hidden className="text-5xl">{choice.picture.emoji}</span>}
            {choice.text === "" ? null : <span className="text-3xl font-semibold">{choice.text}</span>}
          </Button>
        </li>
      ))}
    </ul>
  </div>
);
