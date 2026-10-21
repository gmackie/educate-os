import { Badge, Link, SkeletonLine, Surface, Text } from "@cloudflare/kumo";
import { useCourseActivities } from "./useCourseActivities.ts";
import { courseTitle } from "./labels.ts";
import { coursePath } from "./router.tsx";

/** One class on Home, named from its activities, with how many there are. */
export const CourseCard = ({ offeringId, past }: { offeringId: string; past: boolean }) => {
  const [activities] = useCourseActivities(offeringId);
  const title = activities.status === "ready" ? courseTitle(activities.data) : "Course";
  return (
    <Surface className="flex h-full flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
      {activities.status === "loading" ? (
        <SkeletonLine minWidth={50} maxWidth={80} />
      ) : (
        <Text variant="heading" as="h3">
          <Link href={coursePath(offeringId)} variant="plain">
            {title}
          </Link>
        </Text>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {activities.status === "ready" ? (
          <Text variant="secondary" size="sm">
            {activities.data.length === 1 ? "1 activity" : `${activities.data.length} activities`}
          </Text>
        ) : null}
        {past ? <Badge variant="neutral">Read-only</Badge> : null}
      </div>
    </Surface>
  );
};
