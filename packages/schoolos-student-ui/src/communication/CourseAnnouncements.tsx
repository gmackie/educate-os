import { Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { AnnouncementList } from "./AnnouncementList.tsx";

/** A class's announcements on its page. A class with none shows nothing. */
export const CourseAnnouncements = ({ offeringId }: { offeringId: string }) => {
  const [announcements, reload] = useQuery(`announcements:${offeringId}`, (api) => api.call("student.courseAnnouncements", { params: { offeringId } }));
  if (announcements.status === "loading") return null;
  if (announcements.status === "error") return <ErrorState error={announcements.error} title="We couldn't load this class's announcements" onRetry={reload} />;
  if (announcements.data.length === 0) return null;
  return (
    <section aria-labelledby="announcements" className="flex flex-col gap-3">
      <Text variant="heading" as="h2"><span id="announcements">Announcements</span></Text>
      <AnnouncementList announcements={announcements.data} showClass={false} />
    </section>
  );
};
