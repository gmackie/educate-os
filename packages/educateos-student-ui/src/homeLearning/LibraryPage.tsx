import { Badge, Banner, Button, Surface, Text } from "@cloudflare/kumo";
import { Navigate } from "@tanstack/react-router";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../AppContext.tsx";
import { useApi, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { STRAND_LABEL, TRACK_LABEL } from "./labels.ts";
import { HOME_PATH } from "./paths.ts";
import { useFamily, type FamilyView } from "./useFamily.ts";

type Pack = RouteResponse<"family.library">["packs"][number];
type LibraryActivity = Pack["activities"][number];

/** One activity: what a parent reads before choosing it, and a way to add it for each child. */
const ActivityEntry = ({ activity, pack, family }: { activity: LibraryActivity; pack: Pack; family: FamilyView }) => {
  const api = useApi();
  const announce = useAnnounce();
  const before = activity.after.map((key) => pack.activities.find((a) => a.ref.activity === key)?.title).filter((t): t is string => t !== undefined);
  return (
    <li>
      <details className="rounded-xl border border-kumo-hairline p-4">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
          <span className="font-semibold">{activity.title}</span>
          <Badge variant="neutral">{STRAND_LABEL[activity.strand] ?? activity.strand}</Badge>
          {activity.mode === "check" ? <Badge variant="info">Check</Badge> : null}
          <span className="text-kumo-subtle">{`about ${activity.minutes} min`}</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Text>{activity.preview}</Text>
          <Text variant="secondary" size="sm">{`Skill: ${activity.skillTitle}. ${activity.itemCount} items in its pool; each session uses a fresh selection where it can.`}</Text>
          {before.length > 0 ? <Text variant="secondary" size="sm">{`Usually comes after: ${before.join(", ")}.`}</Text> : null}
          {activity.adultGuide === undefined ? null : (
            <div className="rounded-lg bg-kumo-tint p-3">
              <p className="font-semibold">For you</p>
              <p>{activity.adultGuide}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {family.learners.map((learner) => (
              <Button key={learner.id} size="sm" onClick={() => {
                api.call("family.queueAdd", { params: { learnerId: learner.id }, body: { pack: activity.ref.pack, activity: activity.ref.activity } }).then(
                  () => announce(`Added ${activity.title} to ${learner.displayName}'s plan`),
                  () => announce("That couldn't be added. Try again."),
                );
              }}>{`Add for ${learner.displayName}`}</Button>
            ))}
          </div>
        </div>
      </details>
    </li>
  );
};

const PackSection = ({ pack, family }: { pack: Pack; family: FamilyView }) => (
  <Surface className="flex flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
    <section aria-labelledby={`pack-${pack.id}`} className="flex flex-col gap-4">
      <h2 id={`pack-${pack.id}`} className="flex flex-wrap items-center gap-2 text-xl font-semibold">
        {pack.title}
        <Badge variant="neutral">{TRACK_LABEL[pack.track]}</Badge>
        <span className="text-sm font-normal text-kumo-subtle">{`version ${pack.version}`}</span>
      </h2>
      <Text>{pack.summary}</Text>
      {pack.review.status === "draft" ? (
        <Banner variant="secondary" title="Awaiting educator review" description={`${pack.review.scope} Use it with that in mind; nothing here is a diagnosis or a mastery measure.`} />
      ) : null}
      <ol className="flex flex-col gap-2" aria-label={`${pack.title} activities, in teaching order`}>
        {pack.activities.map((activity) => <ActivityEntry key={activity.ref.activity} activity={activity} pack={pack} family={family} />)}
      </ol>
    </section>
  </Surface>
);

/** The reviewed content packs, in teaching order, with each activity's preview and guide. */
export const LibraryPage = () => {
  const [home] = useFamily();
  const [library, reload] = useQuery("family-library", (api) => api.call("family.library"));
  if (home.status === "ready" && home.data.family === null) return <Navigate to={HOME_PATH} replace />;
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Library</PageHeading>
      <HomeLearningNav />
      <Text>Activities are in teaching order. A grade is only a starting point: choose what fits your child, in reading and math separately.</Text>
      {library.status === "loading" || home.status === "loading" ? <LoadingSkeleton label="Loading the library" /> : null}
      {library.status === "error" ? <ErrorState error={library.error} title="We couldn't load the library" onRetry={reload} /> : null}
      {library.status === "ready" && home.status === "ready" && home.data.family !== null
        ? library.data.packs.map((pack) => <PackSection key={pack.id} pack={pack} family={home.data.family!} />)
        : null}
    </div>
  );
};
