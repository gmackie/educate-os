import { Empty, Switch, Text } from "@cloudflare/kumo";
import { ChatsCircle } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { DiscussionListing, TeachingOffering } from "../types.ts";
import { ModerationPanel } from "./ModerationPanel.tsx";
import { TopicCard } from "./TopicCard.tsx";
import { TopicComposer } from "./TopicComposer.tsx";
import { useSteadyLoad } from "../useSteadyLoad.ts";

const PremoderationSwitch = ({ offeringId, settings, onChanged }: { offeringId: string; settings: DiscussionListing["settings"]; onChanged: () => void }) => {
  const action = useAction(onChanged);
  return (
    <div className="flex flex-col gap-1">
      <Switch
        label="Approve each student post before the class sees it"
        checked={settings.premoderation}
        disabled={action.busy}
        onClick={() => void action.run("premoderation", async (client) => {
          const next = await client.call("teacher.discussionSettings", { params: { offeringId }, body: { premoderation: !settings.premoderation } });
          return next.premoderation ? "Student posts now wait for your approval." : "Student posts now appear once the safety check passes them.";
        })}
      />
      <Text variant="secondary" size="sm">
        {settings.premoderation
          ? "Each student post waits in Needs your attention until you approve it."
          : "Student posts appear for the class once the district's safety check passes them; you can hide or remove any post afterwards."}
      </Text>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </div>
  );
};

/**
 * A class's discussions as its teachers run them: what needs moderating, the class's
 * pre-moderation setting, opening topics, and each topic with its posts.
 */
export const DiscussionsPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const board = useSteadyLoad(`discussions:${offeringId}`, async (client) => {
    const [listing, queue, outline, assignments] = await Promise.all([
      client.call("teacher.listDiscussions", { params: { offeringId } }),
      client.call("teacher.moderationQueue", { params: { offeringId } }),
      client.call("teacher.listModules", { params: { offeringId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
    ]);
    return { listing, queue, modules: outline.outline.modules, assignments };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Discussions · ${classLabel(teaching)}`}</PageHeading>
      {board.error !== undefined && <Problem error={board.error} onRetry={board.reload} />}
      {board.data === undefined && board.error === undefined && <Loading label="Loading the discussions…" />}
      {board.data !== undefined && (
        <>
          <ModerationPanel queue={board.data.queue} topics={board.data.listing.topics.map((t) => t.topic)} onChanged={board.reload} />
          <PremoderationSwitch offeringId={offeringId} settings={board.data.listing.settings} onChanged={board.reload} />
          <TopicComposer offeringId={offeringId} modules={board.data.modules} assignments={board.data.assignments} onCreated={board.reload} />
          {board.data.listing.topics.length === 0
            ? <Empty icon={<ChatsCircle size={32} aria-hidden />} title="No discussions yet" description="Open a discussion for the class to answer in threaded posts." />
            : (
              <ul aria-label="Topics" className="flex flex-col gap-4">
                {board.data.listing.topics.map(({ topic, posts, needsAttention }) => (
                  <li key={topic.id}>
                    <TopicCard
                      topic={topic}
                      posts={posts}
                      needsAttention={needsAttention}
                      modules={board.data!.modules}
                      assignments={board.data!.assignments}
                      onChanged={board.reload}
                    />
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  );
};
