import { Badge, Button, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../AppContext.tsx";
import { useApi, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { FamilySetup } from "./FamilySetup.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { TRACK_LABEL, avatarName } from "./labels.ts";
import { LIBRARY_PATH, progressPath, queuePath, sessionPath } from "./paths.ts";
import { StartPracticeButton } from "./StartPracticeButton.tsx";
import { useFamily } from "./useFamily.ts";

type Today = RouteResponse<"family.today">[number];

/** One child's Today: what's next, what to add, and how the last session went. */
const ChildToday = ({ today, onChanged }: { today: Today; onChanged: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const { learner } = today;
  const headingId = `today-${learner.id}`;
  return (
    <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <h2 id={headingId} className="flex items-center gap-3 text-xl font-semibold">
          <span role="img" aria-label={avatarName(learner.avatar)} className="text-3xl">{learner.avatar}</span>
          {learner.displayName}
        </h2>
        <div className="flex flex-col gap-2">
          <h3 className="font-semibold">Up next</h3>
          {today.next.length === 0 ? (
            <Text variant="secondary">Nothing is queued. Add a suggestion below, or choose from the <Link href={LIBRARY_PATH}>library</Link>.</Text>
          ) : (
            <ol className="flex flex-col gap-1">
              {today.next.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2">
                  <span>{entry.title}</span>
                  <Badge variant="neutral">{TRACK_LABEL[entry.track]}</Badge>
                  {entry.mode === "check" ? <Badge variant="info">Check</Badge> : null}
                  {entry.inProgress ? <Badge variant="warning">Started</Badge> : null}
                  <span className="text-kumo-subtle">{`about ${entry.minutes} min`}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
        {today.suggestions.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">Suggested next</h3>
            <ul className="flex flex-col gap-3">
              {today.suggestions.map((suggestion) => (
                <li key={suggestion.track} className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{suggestion.title}</span>
                    <Badge variant="neutral">{TRACK_LABEL[suggestion.track]}</Badge>
                  </span>
                  <Text variant="secondary" size="sm">{suggestion.preview}</Text>
                  <Button size="sm" className="self-start" onClick={() => {
                    api.call("family.queueAdd", { params: { learnerId: learner.id }, body: { pack: suggestion.ref.pack, activity: suggestion.ref.activity } }).then(() => {
                      announce(`Added ${suggestion.title} to ${learner.displayName}'s plan`);
                      onChanged();
                    }, () => announce("That couldn't be added. Try again."));
                  }}>{`Add ${suggestion.title}`}</Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {today.latest === undefined ? null : (
          <div className="flex flex-col gap-1">
            <h3 className="font-semibold">Last time</h3>
            <Text>{today.latest.note}</Text>
            <Link href={sessionPath(learner.id, today.latest.id)}>See what happened</Link>
          </div>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <StartPracticeButton learnerId={learner.id} displayName={learner.displayName} disabled={today.next.length === 0} />
          <Link href={queuePath(learner.id)} className="py-2">Change the plan</Link>
          <Link href={progressPath(learner.id)} className="py-2">Progress</Link>
        </div>
      </section>
    </Surface>
  );
};

const TodayList = () => {
  const [today, reload] = useQuery("family-today", (api) => api.call("family.today"));
  if (today.status === "loading") return <LoadingSkeleton label="Loading today's practice" />;
  if (today.status === "error") return <ErrorState error={today.error} title="We couldn't load today's practice" onRetry={reload} />;
  if (today.data.length === 0) return <Empty title="No children yet" description="Add a child from Family settings." />;
  return (
    <div className="flex flex-col gap-4">
      {today.data.map((child) => <ChildToday key={child.learner.id} today={child} onChanged={reload} />)}
    </div>
  );
};

/** Home learning's Today: set up a family first, then each child's next practice. */
export const TodayPage = () => {
  const [home, reload] = useFamily();
  if (home.status === "loading") return <LoadingSkeleton label="Loading home learning" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load home learning" onRetry={reload} />;
  if (home.data.family === null) return <FamilySetup onCreated={reload} />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Today</PageHeading>
      <HomeLearningNav />
      <TodayList />
    </div>
  );
};
