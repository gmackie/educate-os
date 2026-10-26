import { useId } from "react";
import { Badge, Table, Text } from "@cloudflare/kumo";
import type { DistrictApiClient } from "@educateos/api-client";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { criterionLabel, formatDateTime, receiptCode } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { Feedback, FeedbackComment } from "../model.ts";

/**
 * Released feedback as its student was given it: the teacher's comments, each with the passage of
 * the work it is about where `passages` has it, and criterion scores. A guardian's family view
 * shows the same record (ADR-0012), worded for a reader who is not the student, and never with a
 * passage: that would show them the child's own work.
 */
export const FeedbackBody = ({ feedback, reader = "student", passages }: {
  feedback: Feedback;
  reader?: "student" | "guardian";
  /** The passage each anchored comment is about, by comment ID. */
  passages?: ReadonlyMap<string, string>;
}) => {
  const criteriaId = useId();
  return (
    <div className="flex flex-col gap-4">
      <Badge variant={feedback.state === "final" ? "success" : "info"}>
        {feedback.state === "final" ? "Final feedback" : reader === "student" ? "Shared by your teacher" : "Shared by the teacher"}
      </Badge>
      {feedback.comments.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Text variant="heading" as="h3">
            Comments
          </Text>
          <ul className="flex flex-col gap-2">
            {feedback.comments.map((comment) => {
              const passage = passages?.get(comment.id);
              return (
                <li key={comment.id} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline bg-kumo-elevated p-3">
                  {passage === undefined ? null : (
                    <blockquote className="border-l-2 border-kumo-hairline pl-3">
                      <span className="sr-only">About this passage of your work: </span>
                      <Text variant="secondary" size="sm" as="span">{`“${passage}”`}</Text>
                    </blockquote>
                  )}
                  <p className="whitespace-pre-wrap">{comment.body}</p>
                  <Text variant="secondary" size="xs">
                    <time dateTime={comment.enteredAt}>{formatDateTime(comment.enteredAt)}</time>
                  </Text>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {feedback.scores.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <Text variant="heading" as="h3">
            <span id={criteriaId}>Criterion results</span>
          </Text>
          <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
            <Table aria-labelledby={criteriaId}>
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
      {feedback.comments.length === 0 && feedback.scores.length === 0 ? (
        <Text>{reader === "student" ? "Your teacher hasn't added comments or scores." : "The teacher hasn't added comments or scores."}</Text>
      ) : null}
    </div>
  );
};

/**
 * The passages of the student's own submitted work that comments are anchored to, by comment ID.
 * A passage that can't be read (work since deleted, say) is left out, and its comment shown alone.
 */
const passagesOf = async (api: DistrictApiClient, comments: readonly FeedbackComment[]): Promise<Map<string, string>> => {
  const passages = new Map<string, string>();
  const texts = new Map<string, Promise<string | undefined>>();
  for (const comment of comments) {
    const anchor = comment.anchor;
    if (anchor === undefined || anchor.region.kind !== "text-range") continue;
    const key = `${anchor.artifactId}@${anchor.revisionId}`;
    if (!texts.has(key)) {
      texts.set(key, api.call("student.getArtifact", { params: { artifactId: anchor.artifactId }, query: { revisionId: anchor.revisionId } }).then(
        (read) => (read.content.kind === "text" ? read.content.text : undefined),
        () => undefined,
      ));
    }
    const text = await texts.get(key);
    const passage = text?.slice(anchor.region.start, anchor.region.end).trim();
    if (passage !== undefined && passage !== "") passages.set(comment.id, passage);
  }
  return passages;
};

/**
 * The student's official grade on the assignment, their submissions with receipt codes, and the
 * feedback on the latest one once the teacher has released it. The district returns only teacher
 * feedback that has been shared with the student; suggested scores and teacher-only notes never
 * reach this screen.
 */
export const FeedbackSection = ({ assignmentId, refreshKey }: { assignmentId: string; refreshKey: string }) => {
  const [state, reload] = useQuery(`feedback:${assignmentId}:${refreshKey}`, async (api) => {
    const params = { params: { assignmentId } };
    const [all, released, grades] = await Promise.all([
      api.call("student.listSubmissions", params),
      // Released feedback for the assignment: an empty list, never an error, while there is none.
      api.call("student.assignmentFeedback", params),
      api.call("student.officialGrades", params),
    ]);
    const submissions = all.filter((s) => s.withdrawnAt === undefined).toSorted((a, b) => b.attempt - a.attempt);
    const latest = submissions[0];
    const feedback = latest === undefined ? undefined : released.find((f) => f.submissionId === latest.id);
    const passages = feedback === undefined ? new Map<string, string>() : await passagesOf(api, feedback.comments);
    return { submissions, feedback, passages, grade: grades.at(-1) };
  });

  if (state.status === "loading") return <LoadingSkeleton label="Loading feedback" />;
  if (state.status === "error") return <ErrorState error={state.error} title="We couldn't load your feedback" onRetry={reload} />;
  const { submissions, feedback, passages, grade } = state.data;

  return (
    <div className="flex flex-col gap-4">
      {grade === undefined ? null : (
        <Text>
          <span className="font-semibold">{`Official grade: ${grade.score.points} out of ${grade.score.maxPoints}`}</span>
          <span className="text-kumo-subtle">
            {" · recorded "}
            <time dateTime={grade.approval.approvedAt}>{formatDateTime(grade.approval.approvedAt)}</time>
          </span>
        </Text>
      )}
      {submissions.length === 0 ? (
        grade === undefined ? <Text variant="secondary">Submit your work to get feedback.</Text> : null
      ) : (
        <>
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
            <FeedbackBody feedback={feedback} passages={passages} />
          )}
        </>
      )}
    </div>
  );
};
