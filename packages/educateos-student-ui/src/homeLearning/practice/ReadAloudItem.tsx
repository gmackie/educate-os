import { Button } from "@cloudflare/kumo";
import { BIG, type ItemProps } from "./types.ts";

const RESULTS = [
  { result: "independent", label: "On their own" },
  { result: "with-help", label: "With help" },
  { result: "not-yet", label: "Not yet" },
] as const;

/** The child reads a sentence aloud; the adult records how it went. Nothing is recorded or heard by the app. */
export const ReadAloudItem = ({ item, disabled, onAnswer }: ItemProps<"read-aloud">) => (
  <div className="flex flex-col gap-6">
    <p lang="en" className="text-4xl font-semibold leading-snug">{item.sentence}</p>
    <fieldset className="flex flex-col gap-3 rounded-xl border border-kumo-hairline p-4">
      <legend className="px-1 text-lg font-semibold">Grown-up: how did it go?</legend>
      <div className="flex flex-wrap gap-3">
        {RESULTS.map(({ result, label }) => (
          <Button key={result} className={BIG} disabled={disabled} onClick={() => onAnswer({ kind: "observed", result })}>{label}</Button>
        ))}
      </div>
    </fieldset>
  </div>
);
