import { useState } from "react";
import { Button, Surface } from "@cloudflare/kumo";
import { ArrowLeftIcon, StarIcon } from "@phosphor-icons/react";
import { ItemStep } from "./ItemStep.tsx";
import { HearButton } from "./HearButton.tsx";
import { quiet, useSpeech } from "./speak.ts";
import { BIG, type PracticeView } from "./types.ts";

/**
 * One practice session: directions and a worked example, then one item a page, then a stopping
 * point. A resumed session starts at its first unsaved item.
 */
export const ActivityRunner = ({ view, onDone }: { view: PracticeView; onDone: () => void }) => {
  const firstOpen = view.items.findIndex((item) => !view.saved.includes(item.key));
  const [page, setPage] = useState<"intro" | number | "done">(view.completed || firstOpen < 0 ? "done" : "intro");
  const start = firstOpen < 0 ? 0 : firstOpen;
  const { speak } = useSpeech();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 tabIndex={-1} className="text-4xl font-bold outline-none">{view.title}</h1>
        <Button variant="ghost" icon={<ArrowLeftIcon aria-hidden />} onClick={() => {
          quiet();
          onDone();
        }}>Stop for now</Button>
      </div>
      <Surface className="rounded-2xl border border-kumo-hairline p-6">
        {page === "intro" ? (
          <section aria-labelledby="practice-intro" className="flex flex-col gap-6">
            <h2 id="practice-intro" tabIndex={-1} ref={(element) => element?.focus()} className="text-3xl font-semibold outline-none">
              {start > 0 ? "Welcome back!" : "Let's get started"}
            </h2>
            <p className="text-2xl">{view.directions}</p>
            <p className="text-xl text-kumo-subtle">{view.example}</p>
            <div className="flex flex-wrap gap-3">
              <HearButton className={BIG} text={`${view.directions} ${view.example}`}>Hear the directions</HearButton>
              <Button className={BIG} variant="primary" onClick={() => {
                setPage(start);
                speak(view.items[start]!.prompt);
              }}>{start > 0 ? "Keep going" : "Let's go"}</Button>
            </div>
            {view.adultGuide === undefined ? null : (
              <details className="rounded-xl border border-kumo-hairline p-4">
                <summary className="cursor-pointer font-semibold">For grown-ups</summary>
                <p className="mt-2">{view.adultGuide}</p>
              </details>
            )}
          </section>
        ) : page === "done" ? (
          <section aria-labelledby="practice-done" className="flex flex-col items-start gap-6">
            <h2 id="practice-done" tabIndex={-1} ref={(element) => element?.focus()} className="flex items-center gap-3 text-4xl font-bold outline-none">
              <StarIcon aria-hidden weight="fill" size={48} />
              All done!
            </h2>
            <p className="text-2xl">Show your grown-up what you did.</p>
            <Button className={BIG} variant="primary" onClick={onDone}>Back to my practice</Button>
          </section>
        ) : (
          <ItemStep
            key={view.items[page]!.key}
            view={view}
            item={view.items[page]!}
            number={page + 1}
            onNext={() => {
              const next = view.items.findIndex((item, index) => index > page && !view.saved.includes(item.key));
              if (next < 0) {
                setPage("done");
                speak("All done! Show your grown-up what you did.");
              } else {
                setPage(next);
                speak(view.items[next]!.prompt);
              }
            }}
          />
        )}
      </Surface>
    </div>
  );
};
