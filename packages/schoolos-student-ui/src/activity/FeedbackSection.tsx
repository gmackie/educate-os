import { Badge, Table, Text } from "@cloudflare/kumo";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { criterionLabel, formatDateTime, receiptCode } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { Feedback } from "../model.ts";

const FeedbackBody = ({ feedback }: { feedback: Feedback }) => (
  <div className="flex flex-col gap-4">
    <Badge variant={feedback.state === "final" ? "success" : "info"}>{feedback.state === "final" ? "Final feedback" : "Shared by your teacher"}</Badge>
    {feedback.comments.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <Text variant="heading" as="h3">
          Comments
        </Text>
        <ul className="flex flex-col gap-2">
          {feedback.comments.map((comment) => (
            <li key={comment.id} className="whitespace-pre-wrap rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
              {comment.body}
              <Text variant="secondary" size="xs">
                <time dateTime={comment.enteredAt}>{formatDateTime(comment.enteredAt)}</time>
              </Text>
            </li>
          ))}
        </ul>
      </div>
    )}
    {feedback.scores.length === 0 ? null : (
      <div className="flex flex-col gap-2">
        <Text variant="heading" as="h3">
          Criterion results
        </Text>
        <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
          <Table>
            <caption className="sr-only">Criterion results</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Criterion</Table.Head>
                <Table.Head>Score</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {feedback.scores.map((score) => (
                <Table.Row key={score.criterionId}>
                  <Table.Cell>{criterionLabel(score.criterionId)}</Table.Cell>
                  <Table.Cell>{score.maxPoints === undefined ? `${score.points} points` : `${score.points} of ${score.maxPoints}`}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      </div>
    )}
    {feedback.comments.length === 0 && feedback.scores.length === 0 ? <Text>Your teacher hasn't added comments or scores.</Text> : null}
  </div>
);

/**
 * The student's submissions with their receipt codes, and the feedback on the latest one once the
 * teacher has released it. The district returns only teacher feedback that has been shared with the
 * student; suggested scores and teacher-only notes never reach this screen.
 */
export const FeedbackSection = ({ assignmentId, refreshKey }: { assignmentId: string; refreshKey: string }) => {
  const [state, reload] = useQuery(`feedback:${assignmentId}:${refreshKey}`, async (api) => {
    const submissions = (await api.call("student.listSubmissions", { params: { assignmentId } }))
      .filter((s) => s.withdrawnAt === undefined)
      .toSorted((a, b) => b.attempt - a.attempt);
    const latest = submissions[0];
    if (latest === undefined) return { submissions, feedback: undefined };
    try {
      return { submissions, feedback: await api.call("student.getFeedback", { params: { submissionId: latest.id } }) };
    } catch (error) {
      if (isNotFound(error)) return { submissions, feedback: undefined };
      throw error;
    }
  });

  if (state.status === "loading") return <LoadingSkeleton label="Loading feedback" />;
  if (state.status === "error") return <ErrorState error={state.error} title="We couldn't load your feedback" onRetry={reload} />;
  const { submissions, feedback } = state.data;
  if (submissions.length === 0) return <Text variant="secondary">Submit your work to get feedback.</Text>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Text variant="heading" as="h3">
          Your submissions
        </Text>
        <ul className="flex flex-col gap-1">
          {submissions.map((submission) => (
            <li key={submission.id}>
              <Text size="sm">
                Attempt {submission.attempt} · <time dateTime={submission.submittedAt}>{formatDateTime(submission.submittedAt)}</time>
                {submission.timing === "late" ? " (late)" : ""} · Receipt code <span className="font-mono">{receiptCode(submission.submissionDigest)}</span>
              </Text>
            </li>
          ))}
        </ul>
      </div>
      {feedback === undefined ? (
        <Text>No feedback yet. You'll see it here when your teacher shares it.</Text>
      ) : (
        <FeedbackBody feedback={feedback} />
      )}
    </div>
  );
};
