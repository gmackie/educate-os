import { Badge, Link, Surface, Text } from "@cloudflare/kumo";
import { useCourseActivities } from "./useCourseActivities.ts";
import { coursePath } from "./router.tsx";

/** One class on Home, by its name, with how many activities it has. */
export const CourseCard = ({ offeringId, title, past }: { offeringId: string; title: string; past: boolean }) => {
  const [activities] = useCourseActivities(offeringId);
  return (
    <Surface className="flex h-full flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
      <Text variant="heading" as="h3">
        <Link href={coursePath(offeringId)} variant="plain">
          {title}
        </Link>
      </Text>
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
