import { Banner, Text } from "@cloudflare/kumo";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useApi, useQuery } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { DiscussionTopic } from "../model.ts";
import { PageText } from "../modules/PageText.tsx";
import { PostComposer } from "./PostComposer.tsx";
import { PostItem } from "./PostItem.tsx";
import { threadTree } from "./threadTree.ts";

/** An open topic: its prompt, the class's posts as a reply tree, and a box to post in. */
export const TopicThread = ({ topic }: { topic: DiscussionTopic }) => {
  const api = useApi();
  const announce = useAnnounce();
  const params = { offeringId: topic.offeringId, topicId: topic.id };
  const [thread, reload] = useQuery(`discussion:${topic.offeringId}:${topic.id}`, (client) => client.call("student.discussionThread", { params }));

  return (
    <div className="flex flex-col gap-4">
      <PageText markdown={topic.prompt} />
      {topic.locked ? (
        <Banner variant="secondary" size="sm" icon={<LockSimpleIcon weight="fill" />} title="This discussion is closed" description="You can read it, but your teacher has stopped new posts." />
      ) : null}
      {thread.status === "loading" ? <LoadingSkeleton label="Loading the discussion" lines={3} /> : null}
      {thread.status === "error" ? <ErrorState error={thread.error} title="We couldn't load this discussion" onRetry={reload} /> : null}
      {thread.status === "ready" ? (
        thread.data.posts.length === 0 ? (
          <Text variant="secondary">No posts yet.</Text>
        ) : (
          <ul aria-label={`Posts in ${topic.title}`} className="flex flex-col gap-3">
            {threadTree(thread.data.posts).map((node) => (
              <PostItem
                key={node.post.id}
                node={node}
                topic={topic}
                authors={new Map(thread.data.authors.map((a) => [a.principalId, a.displayName]))}
                onChanged={reload}
              />
            ))}
          </ul>
        )
      ) : null}
      {topic.locked ? null : (
        <PostComposer
          label="Your post"
          submitLabel="Post"
          onSubmit={async (body) => {
            const post = await api.call("student.createPost", { params, body: { body } });
            announce(post.status === "pending" ? "Your post was sent to your teacher to approve." : "Your post was posted.");
            reload();
          }}
        />
      )}
    </div>
  );
};
