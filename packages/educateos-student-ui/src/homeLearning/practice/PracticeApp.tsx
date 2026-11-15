import { useState } from "react";
import { Button, Empty, Surface } from "@cloudflare/kumo";
import { BookOpenTextIcon, CalculatorIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../../api.tsx";
import { ErrorState } from "../../ErrorState.tsx";
import { LoadingSkeleton } from "../../LoadingSkeleton.tsx";
import { avatarName } from "../labels.ts";
import { ActivityRunner } from "./ActivityRunner.tsx";
import { FinishPractice } from "./FinishPractice.tsx";
import { speak } from "./speak.ts";
import { BIG, type PracticeView } from "./types.ts";

/** Who is practicing on this browser. */
export interface PracticingChild {
  learnerId: string;
  displayName: string;
  avatar: string;
}

/**
 * What a child sees while a child session is open (ADR-0016): the activities their grown-up chose,
 * one at a time. Nothing else in the Learning Home is reachable, and the server refuses every other
 * route, until a grown-up finishes practice with the family PIN.
 */
export const PracticeApp = ({ child, onEnded }: { child: PracticingChild; onEnded: () => void }) => {
  const api = useApi();
  const [home, reload] = useQuery(`practice:${child.learnerId}`, (client) => client.call("learner.home"));
  const [running, setRunning] = useState<{ view: PracticeView } | undefined>(undefined);
  const [starting, setStarting] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<unknown>(undefined);

  const open = (entryId: string) => {
    setStarting(entryId);
    setStartError(undefined);
    api.call("learner.start", { params: { entryId }, body: {} }).then(
      (view) => {
        setRunning({ view });
        setStarting(undefined);
      },
      (error: unknown) => {
        setStartError(error);
        setStarting(undefined);
      },
    );
  };

  const header = (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <p className="flex items-center gap-3 text-2xl font-semibold">
        <span role="img" aria-label={avatarName(child.avatar)} className="text-5xl">{child.avatar}</span>
        {`Hi, ${child.displayName}!`}
      </p>
      <FinishPractice onEnded={onEnded} />
    </header>
  );

  if (running !== undefined) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4" data-presentation="young">
        {header}
        <ActivityRunner view={running.view} onDone={() => {
          setRunning(undefined);
          reload();
        }} />
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-4" data-presentation="young">
      {header}
      <h1 tabIndex={-1} ref={(element) => element?.focus()} className="text-4xl font-bold outline-none">My practice</h1>
      {home.status === "loading" ? <LoadingSkeleton label="Loading your practice" /> : null}
      {home.status === "error" ? <ErrorState error={home.error} title="We couldn't load your practice" onRetry={reload} /> : null}
      {startError === undefined ? null : <ErrorState error={startError} title="That activity didn't open" onRetry={() => setStartError(undefined)} />}
      {home.status === "ready" && home.data.queue.length === 0 ? (
        <Empty title="Nothing to practice right now" description="Ask your grown-up to choose something for you." />
      ) : null}
      {home.status === "ready" && home.data.queue.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2" aria-label="Activities">
          {home.data.queue.map((entry) => (
            <li key={entry.entryId}>
              <Surface className="flex h-full flex-col gap-4 rounded-2xl border border-kumo-hairline p-5">
                <p className="flex items-center gap-3 text-2xl font-semibold">
                  {entry.track === "reading" ? <BookOpenTextIcon aria-hidden size={40} /> : <CalculatorIcon aria-hidden size={40} />}
                  {entry.title}
                </p>
                <Button
                  className={BIG}
                  variant="primary"
                  loading={starting === entry.entryId}
                  disabled={starting !== undefined}
                  onClick={() => {
                    speak(entry.title);
                    open(entry.entryId);
                  }}
                >
                  {entry.inProgress ? `Keep going: ${entry.title}` : `Start: ${entry.title}`}
                </Button>
              </Surface>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};
