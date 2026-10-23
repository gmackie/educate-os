import { Button } from "@cloudflare/kumo";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { DiscussionPost, ModerationDecision } from "../types.ts";

const DONE: Record<ModerationDecision, string> = {
  approve: "Approved. The class can see it now.",
  hide: "Hidden from the class. You can restore it.",
  unhide: "Restored for the class.",
  remove: "Removed for good.",
  "dismiss-flags": "Flags cleared.",
};

const LABEL: Record<ModerationDecision, string> = {
  approve: "Approve",
  hide: "Hide",
  unhide: "Restore",
  remove: "Remove",
  "dismiss-flags": "Clear flags",
};

/** The decisions that apply to a post as it stands. */
const decisionsFor = (post: DiscussionPost): ModerationDecision[] => {
  if (post.deletedAt !== undefined) return post.flags.length > 0 ? ["dismiss-flags"] : [];
  const decisions: ModerationDecision[] = [];
  if (post.status === "pending") decisions.push("approve");
  if (post.status === "visible" || post.status === "pending") decisions.push("hide");
  if (post.status === "hidden") decisions.push("unhide");
  if (post.status !== "removed") decisions.push("remove");
  if (post.flags.length > 0) decisions.push("dismiss-flags");
  return decisions;
};

/** A teacher's moderation buttons for one post: approve, hide or restore, remove, clear flags. */
export const PostActions = ({ post, author, onChanged }: { post: DiscussionPost; author: string; onChanged: () => void }) => {
  const action = useAction(onChanged);
  const decisions = decisionsFor(post);
  if (decisions.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={`Moderate ${author}'s post`} className="flex flex-wrap gap-2">
        {decisions.map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === "approve" ? "primary" : "secondary"}
            loading={action.running(decision)}
            disabled={action.busy}
            onClick={() =>
              void action.run(decision, async (client) => {
                await client.call("teacher.moderatePost", { params: { offeringId: post.offeringId, postId: post.id }, body: { decision } });
                return DONE[decision];
              })}
          >
            {LABEL[decision]}
          </Button>
        ))}
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </div>
  );
};
