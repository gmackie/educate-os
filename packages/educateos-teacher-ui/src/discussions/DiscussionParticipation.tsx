import { Text } from "@cloudflare/kumo";
import { DistrictApiError } from "@educateos/api-client";
import { routeHref } from "../route.ts";
import { useLoad } from "../useLoad.ts";
import { formatDateTime } from "../dates.ts";

/**
 * Where a student's discussion posts count toward an assignment: their posts in the class's topics
 * graded under it, for the teacher to read while grading. The grade itself is recorded on the
 * assignment as any other. Nothing shows for an assignment no topic is graded under.
 */
export const DiscussionParticipation = ({ offeringId, assignmentId, studentPrincipalId, student }: {
  offeringId: string;
  assignmentId: string;
  studentPrincipalId: string;
  student: string;
}) => {
  const participation = useLoad(`participation:${assignmentId}:${studentPrincipalId}`, async (client) => {
    try {
      return await client.call("teacher.discussionParticipation", { params: { assignmentId, principalId: studentPrincipalId } });
    } catch (error) {
      if (error instanceof DistrictApiError && error.code === "not-found") return undefined;
      throw error;
    }
  });
  if (participation.status !== "ready" || participation.data === undefined || participation.data.topics.length === 0) return null;
  const { topics, posts } = participation.data;
  return (
    <section aria-labelledby="participation-heading" className="flex flex-col gap-3">
      <h2 id="participation-heading"><Text variant="heading" as="span">Discussion participation</Text></h2>
      {topics.map((topic) => {
        const theirs = posts.filter((post) => post.topicId === topic.id);
        return (
          <div key={topic.id} className="flex flex-col gap-2">
            <Text bold as="p">
              <a href={routeHref({ screen: "discussions", offeringId })}>{topic.title}</a>
              {` · ${theirs.length === 1 ? "1 post" : `${theirs.length} posts`} by ${student}`}
            </Text>
            {theirs.length > 0 && (
              <ol aria-label={`${student}'s posts in ${topic.title}`} className="flex flex-col gap-2">
                {theirs.map((post) => (
                  <li key={post.id} className="rounded-lg border border-kumo-hairline p-3">
                    <Text variant="secondary" size="sm" as="p">
                      <time dateTime={post.createdAt}>{formatDateTime(post.createdAt)}</time>
                      {post.parentId === undefined ? "" : " · reply"}
                      {post.status === "visible" ? "" : ` · ${post.status}`}
                    </Text>
                    <Text as="p"><span className="whitespace-pre-line">{post.body}</span></Text>
                  </li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </section>
  );
};
