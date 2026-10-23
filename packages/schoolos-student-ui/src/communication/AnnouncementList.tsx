import { Surface, Text } from "@cloudflare/kumo";
import { formatDateTime } from "../labels.ts";
import type { AnnouncementView } from "../model.ts";

/** Announcements, newest first. Their text is shown exactly as the teacher typed it, never as markup. */
export const AnnouncementList = ({ announcements, showClass }: { announcements: readonly AnnouncementView[]; showClass: boolean }) => (
  <ul className="flex flex-col gap-3">
    {announcements.map(({ announcement, courseLabel }) => (
      <li key={announcement.id}>
        <Surface as="article" aria-label={announcement.title} className="flex flex-col gap-1 rounded-lg border border-kumo-hairline p-4">
          <Text variant="heading" as="h3">{announcement.title}</Text>
          <Text variant="secondary" size="sm">
            {showClass ? `${courseLabel} · ` : null}
            <time dateTime={announcement.publishAt}>{formatDateTime(announcement.publishAt)}</time>
          </Text>
          <p className="whitespace-pre-wrap">{announcement.body}</p>
        </Surface>
      </li>
    ))}
  </ul>
);
