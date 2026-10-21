import { useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import { ShareFat } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { Feedback } from "../types.ts";
import { sourceBadge, sourceLabel } from "./feedbackSource.ts";

const STATE_LABEL = { draft: "Not shared yet", "shared-with-student": "Shared with the student", final: "Final" } as const;

/**
 * The comments on a submission, each labelled with who wrote it, and the step that shares the
 * teacher's feedback with the student. Students see the teacher's comments and scores, never the
 * suggestions.
 */
export const FeedbackSharing = ({ submissionId, feedback, excerpt, onShared }: {
  submissionId: string;
  feedback: Feedback;
  excerpt: (comment: Feedback["comments"][number]) => string | undefined;
  onShared: () => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [state, setState] = useState<{ status: "idle" | "sharing" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const share = async () => {
    setState({ status: "sharing" });
    try {
      await client.call("teacher.releaseFeedback", { params: { submissionId }, body: { state: "shared-with-student" } });
      setState({ status: "idle" });
      announce("Feedback shared with the student.");
      onShared();
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <section aria-labelledby="feedback-heading" className="flex flex-col gap-3">
      <h2 id="feedback-heading" className="flex flex-wrap items-center gap-2">
        <Text variant="heading" as="span">Feedback</Text>
        <Badge variant={feedback.state === "draft" ? "neutral" : "success"}>{STATE_LABEL[feedback.state]}</Badge>
      </h2>
      {feedback.comments.length === 0 ? <Text variant="secondary">No comments yet.</Text> : (
        <ul className="flex flex-col gap-2">
          {feedback.comments.map((comment) => {
            const quoted = excerpt(comment);
            return (
              <li key={comment.id} className="flex flex-col gap-1 rounded border border-kumo-line p-3">
                <span><Badge variant={sourceBadge(comment.source)}>{sourceLabel(comment.source)}</Badge></span>
                {quoted !== undefined && <blockquote className="border-l-2 border-kumo-line pl-3"><Text variant="secondary" size="sm">{`“${quoted}”`}</Text></blockquote>}
                <Text>{comment.body}</Text>
              </li>
            );
          })}
        </ul>
      )}
      {feedback.state === "draft" && (
        <div className="flex flex-col gap-1">
          <div>
            <Button variant="primary" icon={<ShareFat aria-hidden />} loading={state.status === "sharing"} onClick={() => void share()}>Share feedback with student</Button>
          </div>
          <Text variant="secondary" size="sm">The student sees your comments and your scores. Suggestions stay with you.</Text>
        </div>
      )}
      {state.status === "failed" && <Problem error={state.error} />}
    </section>
  );
};
