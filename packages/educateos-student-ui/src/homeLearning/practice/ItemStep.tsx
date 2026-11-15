import { useState } from "react";
import { Banner, Button } from "@cloudflare/kumo";
import { ArrowRightIcon, HandWavingIcon, LightbulbIcon, SpeakerHighIcon } from "@phosphor-icons/react";
import { scoreTry, triesAllowed, type Answer } from "@educateos/home-learning/scoring";
import { useApi } from "../../api.tsx";
import { ItemView } from "./ItemView.tsx";
import { quiet, speak } from "./speak.ts";
import { BIG, type Item, type PracticeView } from "./types.ts";

type Outcome = "right" | "try-again" | "finished-wrong" | "recorded";
type Save = "idle" | "saving" | "saved" | "failed";

/** How a finished item's answer is said, for "Good try! It was …". */
const answerText = (item: Item): string | undefined => {
  switch (item.type) {
    case "count-sounds": case "count-objects": case "one-more-less": case "place-on-line": case "number-line-jump":
      return String(item.answer);
    case "build-word": return item.answer;
    case "compare-groups": return item.answer === "left" ? "the group on the left" : "the group on the right";
    case "read-aloud": return undefined;
    default: {
      const choice = item.choices.find((c) => c.key === item.answer);
      return choice?.picture?.label ?? choice?.text;
    }
  }
};

const MESSAGES: Record<Outcome, (item: Item) => string> = {
  right: () => "Yes! That's right.",
  "try-again": () => "Not quite. Have another try.",
  "finished-wrong": (item) => `Good try! It was ${answerText(item)}.`,
  recorded: () => "Thank you, grown-up!",
};

/**
 * One item: its prompt (read aloud on request), the answering part, a hint and "my grown-up
 * helped" where allowed, calm feedback, and the save. A finished item is saved before the child
 * can move on; a failed save says so and keeps the answer to try again.
 */
export const ItemStep = ({ view, item, number, onNext }: { view: PracticeView; item: Item; number: number; onNext: () => void }) => {
  const api = useApi();
  const [requestId] = useState(() => crypto.randomUUID());
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [hintUsed, setHintUsed] = useState(false);
  const [adultHelped, setAdultHelped] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);
  const [save, setSave] = useState<Save>("idle");
  const finished = outcome !== undefined && outcome !== "try-again";
  const check = view.mode === "check";
  const last = number === view.items.length;

  const send = (all: Answer[]) => {
    setSave("saving");
    api.call("learner.save", { params: { sessionId: view.sessionId }, body: { requestId, item: item.key, answers: all, hintUsed, adultHelped } }).then(
      () => setSave("saved"),
      () => setSave("failed"),
    );
  };

  const answer = (given: Answer) => {
    const all = [...answers, given];
    setAnswers(all);
    const { correct } = scoreTry(item, given);
    const next: Outcome = item.type === "read-aloud" ? "recorded" : correct ? "right" : all.length < triesAllowed(view.mode, item) ? "try-again" : "finished-wrong";
    setOutcome(next);
    speak(MESSAGES[next](item));
    if (next !== "try-again") send(all);
  };

  return (
    <section aria-labelledby={`item-${number}`} className="flex flex-col gap-6">
      <h2 id={`item-${number}`} tabIndex={-1} ref={(element) => element?.focus()} className="text-xl font-semibold text-kumo-subtle outline-none">
        {`${number} of ${view.items.length}`}
      </h2>
      <div className="flex flex-wrap items-start gap-3">
        <p className="text-2xl">{item.prompt}</p>
        <Button variant="ghost" icon={<SpeakerHighIcon aria-hidden />} onClick={() => speak(item.prompt)}>Hear it again</Button>
      </div>

      {/* Remounted for each try, so a second try starts clean. */}
      <ItemView key={answers.length} item={item} disabled={finished} onAnswer={answer} />

      {!finished && item.type !== "read-aloud" ? (
        <div className="flex flex-wrap gap-3">
          {!check && item.hint !== undefined ? (
            <Button icon={<LightbulbIcon aria-hidden />} disabled={hintUsed} onClick={() => {
              setHintUsed(true);
              speak(item.hint!);
            }}>Hint</Button>
          ) : null}
          <Button icon={<HandWavingIcon aria-hidden />} aria-pressed={adultHelped} onClick={() => setAdultHelped(true)}>Ask my grown-up</Button>
        </div>
      ) : null}
      {hintUsed && item.hint !== undefined ? <p className="rounded-xl border border-kumo-hairline p-4 text-xl">{item.hint}</p> : null}
      {adultHelped && !finished ? <p className="text-xl">Your grown-up can help you now.</p> : null}

      <div role="status" className="text-2xl font-semibold">{outcome === undefined ? null : MESSAGES[outcome](item)}</div>

      {save === "failed" ? (
        <div role="alert" className="flex flex-col gap-3">
          <Banner variant="error" title="This answer isn't saved yet" description="Check the connection. Your answer is kept here until it saves." />
          <Button className={`${BIG} self-start`} onClick={() => send(answers)}>Try saving again</Button>
        </div>
      ) : null}
      {save === "saving" ? <p className="text-kumo-subtle">Saving…</p> : null}
      {save === "saved" ? (
        <Button className={`${BIG} self-start`} variant="primary" icon={<ArrowRightIcon aria-hidden />} onClick={() => {
          quiet();
          onNext();
        }}>{last ? "Finish" : "Next"}</Button>
      ) : null}
    </section>
  );
};
