import { useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon, ChatsCircleIcon, LockSimpleIcon, PushPinIcon } from "@phosphor-icons/react";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { TopicThread } from "./TopicThread.tsx";

/**
 * A class's discussions: its topics, pinned first, each opening into its thread. Posts appear for
 * the class once the district has screened them; a class whose teacher approves posts first shows
 * the student their own post as waiting. A class with no topics shows nothing here.
 */
export const CourseDiscussions = ({ offeringId }: { offeringId: string }) => {
  const [openTopic, setOpenTopic] = useState<string | undefined>();
  const [listing, reload] = useQuery(`discussions:${offeringId}`, async (api) => {
    try {
      return await api.call("student.listDiscussions", { params: { offeringId } });
    } catch (error) {
      // A class the student has left, or a district without discussions, answers not-found.
      if (isNotFound(error)) return undefined;
      throw error;
    }
  });
  if (listing.status === "loading") return null;
  if (listing.status === "error") return <ErrorState error={listing.error} title="We couldn't load this class's discussions" onRetry={reload} />;
  if (listing.data === undefined || listing.data.topics.length === 0) return null;

  return (
    <section aria-labelledby="discussions" className="flex flex-col gap-3">
      <Text variant="heading" as="h2">
        <span id="discussions">Discussions</span>
      </Text>
      {listing.data.settings.premoderation ? (
        <Text variant="secondary" size="sm">Your teacher reads each post before the class sees it.</Text>
      ) : null}
      <ul className="flex flex-col gap-3">
        {listing.data.topics.map(({ topic, posts }) => {
          const open = openTopic === topic.id;
          const panelId = `topic-${topic.id}`;
          return (
            <li key={topic.id}>
              <Surface as="section" aria-label={topic.title} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Text variant="heading" as="h3">
                    <Button
                      variant="ghost"
                      aria-expanded={open}
                      aria-controls={panelId}
                      icon={open ? <CaretDownIcon aria-hidden /> : <CaretRightIcon aria-hidden />}
                      onClick={() => setOpenTopic(open ? undefined : topic.id)}
                    >
                      {topic.title}
                    </Button>
                  </Text>
                  {topic.pinned ? <Badge variant="neutral"><PushPinIcon aria-hidden /> Pinned</Badge> : null}
                  {topic.locked ? <Badge variant="neutral"><LockSimpleIcon aria-hidden /> Closed</Badge> : null}
                  <Text variant="secondary" size="sm">
                    <ChatsCircleIcon aria-hidden /> {posts === 1 ? "1 post" : `${posts} posts`}
                  </Text>
                </div>
                <div id={panelId} hidden={!open}>
                  {open ? <TopicThread topic={topic} onChanged={reload} /> : null}
                </div>
              </Surface>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
