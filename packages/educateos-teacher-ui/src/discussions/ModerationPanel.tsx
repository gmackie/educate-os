import { useId } from "react";
import { Text } from "@cloudflare/kumo";
import type { DiscussionPost, DiscussionTopic, ModerationQueue } from "../types.ts";
import { PostActions } from "./PostActions.tsx";
import { PostSummary } from "./PostSummary.tsx";

const QueuedPost = ({ post, topic, names, onChanged }: { post: DiscussionPost; topic: string; names: ReadonlyMap<string, string>; onChanged: () => void }) => {
  const headingId = useId();
  return (
    <li>
      <article aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3">
        <Text variant="secondary" size="sm">In {topic}</Text>
        <PostSummary post={post} names={names} headingId={headingId} />
        <PostActions post={post} author={names.get(post.authorId) ?? "this student"} onChanged={onChanged} />
      </article>
    </li>
  );
};

/**
 * What needs the teacher across the class's discussions: posts waiting for approval, and posts
 * the safety check or a student flagged. Nothing shows when nothing needs them.
 */
export const ModerationPanel = ({ queue, topics, onChanged }: { queue: ModerationQueue; topics: readonly DiscussionTopic[]; onChanged: () => void }) => {
  const names = new Map(queue.authors.map((a) => [a.principalId, a.displayName]));
  const topicTitle = (post: DiscussionPost) => topics.find((t) => t.id === post.topicId)?.title ?? "a discussion";
  // A post both waiting and flagged is listed once, as waiting.
  const flagged = queue.flagged.filter((post) => post.status !== "pending");
  if (queue.pending.length === 0 && flagged.length === 0) return null;
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <h2 id="needs-you"><Text variant="heading" as="span">Needs your attention</Text></h2>
      {queue.pending.length > 0 && (
        <ul aria-label="Waiting for approval" className="flex flex-col gap-2">
          {queue.pending.map((post) => <QueuedPost key={post.id} post={post} topic={topicTitle(post)} names={names} onChanged={onChanged} />)}
        </ul>
      )}
      {flagged.length > 0 && (
        <ul aria-label="Flagged posts" className="flex flex-col gap-2">
          {flagged.map((post) => <QueuedPost key={post.id} post={post} topic={topicTitle(post)} names={names} onChanged={onChanged} />)}
        </ul>
      )}
    </section>
  );
};
