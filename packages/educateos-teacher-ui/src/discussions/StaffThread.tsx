import { useId, useState } from "react";
import { Button, InputArea, Text } from "@cloudflare/kumo";
import { ArrowBendUpLeft } from "@phosphor-icons/react";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { DiscussionPost, DiscussionTopic } from "../types.ts";
import { PostActions } from "./PostActions.tsx";
import { PostSummary } from "./PostSummary.tsx";
import { useSteadyLoad } from "../useSteadyLoad.ts";
import { useLoad } from "../useLoad.ts";

interface Node {
  post: DiscussionPost;
  replies: Node[];
}

const tree = (posts: readonly DiscussionPost[]): Node[] => {
  const nodes = new Map(posts.map((post) => [post.id, { post, replies: [] as Node[] }]));
  const roots: Node[] = [];
  for (const node of nodes.values()) (node.post.parentId === undefined ? roots : nodes.get(node.post.parentId)?.replies ?? roots).push(node);
  return roots;
};

/** A teacher's post or reply: they are never screened and never wait for approval. */
const TeacherComposer = ({ label, submitLabel, topic, parentId, onPosted }: {
  label: string;
  submitLabel: string;
  topic: DiscussionTopic;
  parentId?: string;
  onPosted: () => void;
}) => {
  const [text, setText] = useState("");
  const action = useAction(onPosted);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run("post", async (client) => {
          await client.call("teacher.createPost", {
            params: { offeringId: topic.offeringId, topicId: topic.id },
            body: { body: text, ...(parentId === undefined ? {} : { parentId }) },
          });
          setText("");
          return parentId === undefined ? "Posted." : "Reply posted.";
        });
      }}
    >
      <InputArea label={label} value={text} autoResize minRows={2} maxRows={10} onValueChange={setText} />
      <div>
        <Button type="submit" size="sm" variant="primary" loading={action.running("post")} disabled={text.trim() === "" || action.busy}>{submitLabel}</Button>
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </form>
  );
};

const PostNode = ({ node, topic, names, viewerId, onChanged }: {
  node: Node;
  topic: DiscussionTopic;
  names: ReadonlyMap<string, string>;
  /** The teacher reading, once known, so their own posts read as theirs. */
  viewerId: string | undefined;
  onChanged: () => void;
}) => {
  const headingId = useId();
  const [replying, setReplying] = useState(false);
  const author = names.get(node.post.authorId) ?? "Unknown author";
  const replyLabel = node.post.authorId === viewerId ? "Reply to your post" : `Reply to ${author}`;
  return (
    <li className="flex flex-col gap-2">
      <article aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3">
        <PostSummary post={node.post} names={names} headingId={headingId} />
        <div className="flex flex-wrap items-start gap-2">
          <PostActions post={node.post} author={author} onChanged={onChanged} />
          {topic.settings.allowReplies && node.post.status === "visible" && node.post.deletedAt === undefined && !replying && (
            <Button size="sm" variant="ghost" icon={<ArrowBendUpLeft aria-hidden />} aria-label={replyLabel} onClick={() => setReplying(true)}>Reply</Button>
          )}
        </div>
        {replying && (
          <TeacherComposer
            label={replyLabel}
            submitLabel="Post reply"
            topic={topic}
            parentId={node.post.id}
            onPosted={() => {
              setReplying(false);
              onChanged();
            }}
          />
        )}
      </article>
      {node.replies.length > 0 && (
        <ul aria-label={`Replies to ${author}`} className="ml-4 flex flex-col gap-2 border-l border-kumo-hairline pl-3 sm:ml-6">
          {node.replies.map((reply) => <PostNode key={reply.post.id} node={reply} topic={topic} names={names} viewerId={viewerId} onChanged={onChanged} />)}
        </ul>
      )}
    </li>
  );
};

/**
 * Every post in a topic as its teachers see it, as a reply tree: hidden, removed and waiting posts
 * included and marked, each with its flags and moderation buttons. Teachers post and reply here
 * too, even in a closed topic.
 */
export const StaffThread = ({ topic, onChanged }: { topic: DiscussionTopic; onChanged: () => void }) => {
  const thread = useSteadyLoad(`staff-thread:${topic.id}`, (client) =>
    client.call("teacher.discussionThread", { params: { offeringId: topic.offeringId, topicId: topic.id } }));
  const me = useLoad("me", (client) => client.call("me.get"));
  const changed = () => {
    thread.reload();
    onChanged();
  };
  if (thread.error !== undefined) return <Problem error={thread.error} onRetry={thread.reload} />;
  if (thread.data === undefined) return <Loading label="Loading the posts…" />;
  const names = new Map(thread.data.authors.map((a) => [a.principalId, a.displayName]));
  return (
    <div className="flex flex-col gap-3">
      {thread.data.posts.length === 0
        ? <Text variant="secondary">No posts yet.</Text>
        : (
          <ul aria-label={`Posts in ${topic.title}`} className="flex flex-col gap-3">
            {tree(thread.data.posts).map((node) => <PostNode key={node.post.id} node={node} topic={topic} names={names} viewerId={me.status === "ready" ? me.data.principalId : undefined} onChanged={changed} />)}
          </ul>
        )}
      <TeacherComposer label="Post to the class" submitLabel="Post" topic={topic} onPosted={changed} />
    </div>
  );
};
