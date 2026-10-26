import { Badge, Text } from "@cloudflare/kumo";
import type { DiscussionPost } from "../types.ts";
import { formatDateTime } from "../dates.ts";

const STATUS: Record<DiscussionPost["status"], { label: string; variant: "neutral" | "secondary" | "success" | "error" } | undefined> = {
  visible: undefined,
  pending: { label: "Waiting for approval", variant: "secondary" },
  hidden: { label: "Hidden", variant: "neutral" },
  removed: { label: "Removed", variant: "error" },
};

const REPORT_REASON: Record<string, string> = {
  unkind: "unkind or hurtful",
  unsafe: "a safety worry",
  "off-topic": "off topic",
  other: "something else",
};

/** Why a post is flagged, in words: what the safety check said, or who reported it and why. */
const flagText = (flag: DiscussionPost["flags"][number], names: ReadonlyMap<string, string>): string =>
  flag.kind === "screening"
    ? flag.decision === "hold" ? "The safety check held this post for you to review." : "The safety check let this post through with a concern."
    : `Reported by ${names.get(flag.by) ?? "a student"}: ${REPORT_REASON[flag.reason] ?? flag.reason}.`;

/**
 * A post as its teachers read it: who wrote it and when, its moderation status, its flags, and its
 * text as written (never rendered as markup).
 */
export const PostSummary = ({ post, names, headingId }: { post: DiscussionPost; names: ReadonlyMap<string, string>; headingId: string }) => {
  const status = STATUS[post.status];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Text bold as="span"><span id={headingId}>{names.get(post.authorId) ?? "Unknown author"}</span></Text>
        {post.authorRole === "staff" && <Badge variant="info">Teacher</Badge>}
        <Text variant="secondary" size="sm" as="span">
          <time dateTime={post.createdAt}>{formatDateTime(post.createdAt)}</time>
          {post.editedAt !== undefined && " (edited)"}
        </Text>
        {status !== undefined && <Badge variant={status.variant}>{status.label}</Badge>}
        {post.flags.length > 0 && <Badge variant="warning">{post.flags.length === 1 ? "1 flag" : `${post.flags.length} flags`}</Badge>}
      </div>
      {post.deletedAt === undefined
        ? <Text as="p"><span className="whitespace-pre-line">{post.body}</span></Text>
        : <Text variant="secondary" as="p">Deleted by its author.</Text>}
      {post.flags.length > 0 && (
        <ul aria-label="Flags" className="flex flex-col gap-1">
          {post.flags.map((flag, index) => <li key={index}><Text size="sm">{flagText(flag, names)}</Text></li>)}
        </ul>
      )}
    </div>
  );
};
