import { Badge, Button, Empty, Surface, Text } from "@cloudflare/kumo";
import { Megaphone } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { useAction } from "../modules/useAction.ts";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import type { ClassAnnouncement, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { AnnouncementComposer } from "./AnnouncementComposer.tsx";
import { WeeklyNoteForm } from "./WeeklyNoteForm.tsx";
import { formatDateTime } from "../dates.ts";


const AnnouncementItem = ({ entry, busy, deleting, onDelete }: { entry: ClassAnnouncement; busy: boolean; deleting: boolean; onDelete: () => void }) => {
  const { announcement, published } = entry;
  return (
    <Surface as="article" aria-label={announcement.title} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text variant="heading" as="h3">{announcement.title}</Text>
        {published ? <Badge variant="success">Published</Badge> : <Badge variant="neutral">Scheduled</Badge>}
      </div>
      <Text variant="secondary" size="sm">
        {published ? "Posted " : "Students see it from "}
        <time dateTime={announcement.publishAt}>{formatDateTime(announcement.publishAt)}</time>
      </Text>
      <p className="whitespace-pre-wrap">{announcement.body}</p>
      <div>
        <Button size="sm" variant="secondary" loading={deleting} disabled={busy} onClick={onDelete} aria-label={`Delete ${announcement.title}`}>
          Delete
        </Button>
      </div>
    </Surface>
  );
};

/**
 * A class's announcements: the teacher posts one now or schedules it, sees what students see and
 * what is still waiting, and deletes any. Below, the week's note to families for the digest.
 */
export const AnnouncementsPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const data = useLoad(`announcements:${offeringId}`, async (client) => {
    const [announcements, note] = await Promise.all([
      client.call("teacher.listAnnouncements", { params: { offeringId } }),
      client.call("teacher.weeklyNote", { params: { offeringId } }),
    ]);
    return { announcements, note };
  });
  const action = useAction(data.reload);

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Announcements · ${classLabel(teaching)}`}</PageHeading>
      <AnnouncementComposer
        saving={action.running("post")}
        onPost={(draft) => action.run("post", async (client) => {
          const posted = await client.call("teacher.createAnnouncement", { params: { offeringId }, body: draft });
          return posted.published ? "Announcement posted" : "Announcement scheduled";
        })}
      />
      {action.state.status === "failed" ? <Problem error={action.state.error} /> : null}
      {data.status === "loading" ? <Loading label="Loading announcements…" /> : null}
      {data.status === "error" ? <Problem error={data.error} onRetry={data.reload} /> : null}
      {data.status === "ready" ? (
        <>
          <section aria-labelledby="posted" className="flex flex-col gap-3">
            <Text variant="heading" as="h2"><span id="posted">Posted and scheduled</span></Text>
            {data.data.announcements.length === 0 ? (
              <Empty icon={<Megaphone size={32} aria-hidden />} title="No announcements yet" description="Post one above; students in this class see it on their class page." />
            ) : (
              <ul className="flex flex-col gap-3">
                {data.data.announcements.map((entry) => (
                  <li key={entry.announcement.id}>
                    <AnnouncementItem
                      entry={entry}
                      busy={action.busy}
                      deleting={action.running(`delete:${entry.announcement.id}`)}
                      onDelete={() => void action.run(`delete:${entry.announcement.id}`, async (client) => {
                        await client.call("teacher.deleteAnnouncement", { params: { announcementId: entry.announcement.id } });
                        return `Deleted ${entry.announcement.title}`;
                      })}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="families" className="flex flex-col gap-3">
            <Text variant="heading" as="h2"><span id="families">Note to families</span></Text>
            <WeeklyNoteForm
              key={`${data.data.note.week}:${data.data.note.note?.updated.at ?? ""}`}
              current={data.data.note}
              saving={action.running("note")}
              onSave={(text) => action.run("note", async (client) => {
                const saved = await client.call("teacher.setWeeklyNote", { params: { offeringId }, body: { week: data.data.note.week, text } });
                return saved.note === null ? "Note removed" : "Note saved";
              })}
            />
          </section>
        </>
      ) : null}
    </div>
  );
};
