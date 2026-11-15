import { useState } from "react";
import { Badge, Button, Empty, Link, Surface } from "@cloudflare/kumo";
import { ArrowDownIcon, ArrowUpIcon, PauseIcon, PlayIcon, TrashIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../AppContext.tsx";
import { messageFor, useApi } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { TRACK_LABEL } from "./labels.ts";
import { LearnerSwitcher } from "./LearnerSwitcher.tsx";
import { HOME_PATH, LIBRARY_PATH, queuePath } from "./paths.ts";
import { StartPracticeButton } from "./StartPracticeButton.tsx";
import { useFamily } from "./useFamily.ts";

type Queue = RouteResponse<"family.queueChange">;

/**
 * One child's plan: the activities they'll be offered, in order. Moving, pausing or removing one
 * changes only what comes next; practice already saved is never changed.
 */
export const QueuePage = ({ learnerId }: { learnerId: string }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [home, reload] = useFamily();
  const [changed, setChanged] = useState<Queue | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  if (home.status === "loading") return <LoadingSkeleton label="Loading the plan" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load the plan" onRetry={reload} />;
  const family = home.data.family;
  if (family === null) return <Navigate to={HOME_PATH} replace />;
  const learner = family.learners.find((l) => l.id === learnerId);
  if (learner === undefined) return <Empty title="We couldn't find that child" description="Choose a child from Today." />;
  const queue = changed ?? family.queues[learnerId] ?? [];

  const change = (call: Promise<Queue>, said: string) => {
    setError(undefined);
    call.then((next) => {
      setChanged(next);
      announce(said);
    }, (caught: unknown) => setError(messageFor(caught)));
  };
  const params = (entryId: string) => ({ learnerId, entryId });

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`${learner.displayName}'s plan`}</PageHeading>
      <HomeLearningNav />
      <LearnerSwitcher family={family} current={learnerId} pathFor={queuePath} />
      {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
      {queue.length === 0 ? (
        <Empty title="Nothing planned" description="Add activities from the library or from Today's suggestions." contents={<Link href={LIBRARY_PATH}>Open the library</Link>} />
      ) : (
        <ol className="flex flex-col gap-3" aria-label={`${learner.displayName}'s activities, in order`}>
          {queue.map((entry, index) => (
            <li key={entry.id}>
              <Surface className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kumo-hairline p-4">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{entry.title}</span>
                  <Badge variant="neutral">{TRACK_LABEL[entry.track]}</Badge>
                  {entry.mode === "check" ? <Badge variant="info">Check</Badge> : null}
                  {entry.paused ? <Badge variant="warning">Paused</Badge> : null}
                  {entry.inProgress ? <Badge variant="secondary">Started</Badge> : null}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button size="sm" shape="square" variant="ghost" aria-label={`Move ${entry.title} up`} disabled={index === 0}
                    onClick={() => change(api.call("family.queueChange", { params: params(entry.id), body: { moveTo: index - 1 } }), `Moved ${entry.title} up`)}>
                    <ArrowUpIcon aria-hidden />
                  </Button>
                  <Button size="sm" shape="square" variant="ghost" aria-label={`Move ${entry.title} down`} disabled={index === queue.length - 1}
                    onClick={() => change(api.call("family.queueChange", { params: params(entry.id), body: { moveTo: index + 1 } }), `Moved ${entry.title} down`)}>
                    <ArrowDownIcon aria-hidden />
                  </Button>
                  <Button size="sm" variant="ghost" icon={entry.paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
                    onClick={() => change(api.call("family.queueChange", { params: params(entry.id), body: { paused: !entry.paused } }), `${entry.paused ? "Resumed" : "Paused"} ${entry.title}`)}>
                    {entry.paused ? `Resume ${entry.title}` : `Pause ${entry.title}`}
                  </Button>
                  <Button size="sm" variant="secondary-destructive" icon={<TrashIcon aria-hidden />}
                    onClick={() => change(api.call("family.queueRemove", { params: params(entry.id), body: {} }), `Removed ${entry.title}`)}>
                    {`Remove ${entry.title}`}
                  </Button>
                </span>
              </Surface>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-start gap-3">
        <StartPracticeButton learnerId={learner.id} displayName={learner.displayName} disabled={!queue.some((e) => !e.paused)} />
        <Link href={LIBRARY_PATH} className="py-2">Add from the library</Link>
      </div>
    </div>
  );
};
