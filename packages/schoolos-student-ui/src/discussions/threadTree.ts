// Turning a topic's flat list of posts into the reply tree the thread shows.
import { DistrictApiError } from "@schoolos/api-client";
import { messageFor } from "../api.tsx";
import type { DiscussionPostView } from "../model.ts";

/** One post and the replies beneath it, in the order they were written. */
export interface ThreadNode {
  post: DiscussionPostView;
  replies: ThreadNode[];
}

/**
 * The thread as a tree. A reply whose parent the student cannot see (the district leaves out a
 * withdrawn post only when nothing readable sits beneath it) is shown at the top level rather than lost.
 */
export const threadTree = (posts: readonly DiscussionPostView[]): ThreadNode[] => {
  const nodes = new Map(posts.map((post) => [post.id, { post, replies: [] as ThreadNode[] }]));
  const roots: ThreadNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.post.parentId === undefined ? undefined : nodes.get(node.post.parentId);
    (parent?.replies ?? roots).push(node);
  }
  return roots;
};

/**
 * What a student is told when a post, edit or report fails. The district writes its refusals
 * (screening, a locked topic) for the student, so those messages are shown as they are.
 */
export const postErrorMessage = (error: unknown): string => {
  if (error instanceof DistrictApiError && (error.code === "policy-violation" || error.code === "forbidden" || error.code === "unavailable")) return error.message;
  return messageFor(error);
};
