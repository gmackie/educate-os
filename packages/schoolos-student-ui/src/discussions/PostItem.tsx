import { useId, useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { ArrowBendUpLeftIcon, FlagIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { formatDateTime } from "../labels.ts";
import type { DiscussionTopic } from "../model.ts";
import { PageText } from "../modules/PageText.tsx";
import { PostComposer } from "./PostComposer.tsx";
import { ReportForm } from "./ReportForm.tsx";
import { postErrorMessage, type ThreadNode } from "./threadTree.ts";

type Mode = "reading" | "replying" | "editing" | "reporting" | "deleting";

/**
 * One post, with what the student may do to it, and its replies beneath it as a nested list. A
 * student edits and deletes their own posts, and replies to or reports anyone else's; a locked
 * topic takes only reports.
 */
export const PostItem = ({ node, topic, authors, onChanged }: {
  node: ThreadNode;
  topic: DiscussionTopic;
  authors: ReadonlyMap<string, string>;
  onChanged: () => void;
}) => {
  const api = useApi();
  const announce = useAnnounce();
  const headingId = useId();
  const [mode, setMode] = useState<Mode>("reading");
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const { post, replies } = node;
  const params = { offeringId: topic.offeringId, postId: post.id };

  if (post.status === "withdrawn") {
    return (
      <li className="flex flex-col gap-2">
        <article aria-labelledby={headingId} className="rounded-lg border border-dashed border-kumo-hairline p-3">
          <Text variant="secondary" size="sm"><span id={headingId}>This post was removed.</span></Text>
        </article>
        <Replies replies={replies} topic={topic} authors={authors} onChanged={onChanged} label="Replies to a removed post" />
      </li>
    );
  }

  const author = post.mine ? "You" : authors.get(post.authorId) ?? "A classmate";
  const open = !topic.locked;
  const canReply = open && topic.settings.allowReplies && post.status === "visible";
  return (
    <li className="flex flex-col gap-2">
      <article aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-3">
        <header className="flex flex-wrap items-center gap-2">
          <Text variant="heading" as="h4"><span id={headingId}>{author}</span></Text>
          {post.authorRole === "staff" ? <Badge variant="info">Teacher</Badge> : null}
          <Text variant="secondary" size="sm">
            <time dateTime={post.createdAt}>{formatDateTime(post.createdAt)}</time>
            {post.editedAt === undefined ? null : " (edited)"}
          </Text>
          {post.status === "pending" ? <Badge variant="neutral">Waiting for your teacher</Badge> : null}
        </header>
        {mode === "editing" ? (
          <PostComposer
            label="Edit your post"
            submitLabel="Save"
            initialText={post.body}
            onCancel={() => setMode("reading")}
            onSubmit={async (body) => {
              await api.call("student.editPost", { params, body: { body } });
              setMode("reading");
              announce("Your post was saved.");
              onChanged();
            }}
          />
        ) : (
          <PageText markdown={post.body} />
        )}
        {mode === "reading" ? (
          <div className="flex flex-wrap gap-2">
            {canReply ? <Button size="sm" variant="secondary" icon={<ArrowBendUpLeftIcon aria-hidden />} onClick={() => setMode("replying")} aria-label={`Reply to ${author}`}>Reply</Button> : null}
            {post.mine && open ? (
              <>
                <Button size="sm" variant="secondary" icon={<PencilSimpleIcon aria-hidden />} onClick={() => setMode("editing")}>Edit</Button>
                <Button size="sm" variant="secondary" icon={<TrashIcon aria-hidden />} onClick={() => setMode("deleting")}>Delete</Button>
              </>
            ) : null}
            {!post.mine && post.status === "visible" ? (
              <Button size="sm" variant="ghost" icon={<FlagIcon aria-hidden />} onClick={() => setMode("reporting")} aria-label={`Report ${author}'s post`}>Report</Button>
            ) : null}
          </div>
        ) : null}
        {mode === "deleting" ? (
          <div role="group" aria-label="Delete your post" className="flex flex-wrap items-center gap-2">
            <Text size="sm">Delete this post? Replies to it stay.</Text>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setDeleteError(undefined);
                api.call("student.deletePost", { params }).then(() => {
                  announce("Your post was deleted.");
                  onChanged();
                }, (caught: unknown) => setDeleteError(postErrorMessage(caught)));
              }}
            >
              Delete
            </Button>
            <Button size="sm" onClick={() => setMode("reading")}>Keep it</Button>
            {deleteError === undefined ? null : <span role="alert"><Text size="sm">{deleteError}</Text></span>}
          </div>
        ) : null}
        {mode === "reporting" ? (
          <ReportForm
            onCancel={() => setMode("reading")}
            onReport={async (reason) => {
              await api.call("student.reportPost", { params, body: { reason } });
              setMode("reading");
              announce("Thanks. Your teacher will look at this post.");
            }}
          />
        ) : null}
        {mode === "replying" ? (
          <PostComposer
            label={`Reply to ${author}`}
            submitLabel="Post reply"
            onCancel={() => setMode("reading")}
            onSubmit={async (body) => {
              const reply = await api.call("student.createPost", { params: { offeringId: topic.offeringId, topicId: topic.id }, body: { body, parentId: post.id } });
              setMode("reading");
              announce(reply.status === "pending" ? "Your reply was sent to your teacher to approve." : "Your reply was posted.");
              onChanged();
            }}
          />
        ) : null}
      </article>
      <Replies replies={replies} topic={topic} authors={authors} onChanged={onChanged} label={`Replies to ${author}`} />
    </li>
  );
};

const Replies = ({ replies, topic, authors, onChanged, label }: {
  replies: readonly ThreadNode[];
  topic: DiscussionTopic;
  authors: ReadonlyMap<string, string>;
  onChanged: () => void;
  label: string;
}) =>
  replies.length === 0 ? null : (
    <ul aria-label={label} className="ml-4 flex flex-col gap-2 border-l border-kumo-hairline pl-3 sm:ml-6">
      {replies.map((reply) => <PostItem key={reply.post.id} node={reply} topic={topic} authors={authors} onChanged={onChanged} />)}
    </ul>
  );
