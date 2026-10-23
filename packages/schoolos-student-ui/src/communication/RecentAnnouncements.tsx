import { Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { AnnouncementList } from "./AnnouncementList.tsx";

/** How many of the newest announcements Home shows. */
const SHOWN = 3;

/**
 * The newest announcements across the student's classes, on Home. Nothing shows while there are
 * none, or if they cannot be loaded: each class page shows its own, with a way to retry.
 */
export const RecentAnnouncements = () => {
  const [announcements] = useQuery("announcements", (api) => api.call("student.announcements"));
  if (announcements.status !== "ready" || announcements.data.length === 0) return null;
  return (
    <section aria-labelledby="recent-announcements" className="flex flex-col gap-3">
      <Text variant="heading" as="h2"><span id="recent-announcements">Announcements</span></Text>
      <AnnouncementList announcements={announcements.data.slice(0, SHOWN)} showClass />
    </section>
  );
};
