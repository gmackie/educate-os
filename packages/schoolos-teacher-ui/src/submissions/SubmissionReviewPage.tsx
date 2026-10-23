import { useState } from "react";
import { Badge, Text } from "@cloudflare/kumo";
import { useRubricShelf } from "../activities/RubricShelf.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import type { CheckRun, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { CheckResults } from "./CheckResults.tsx";
import { FeedbackSharing } from "./FeedbackSharing.tsx";
import { OfficialGrade } from "./OfficialGrade.tsx";
import { reviewCriteria, teacherTotal } from "./rubricCriteria.ts";
import { RubricScores } from "./RubricScores.tsx";
import { SubmittedWork } from "./SubmittedWork.tsx";
import { DiscussionParticipation } from "../discussions/DiscussionParticipation.tsx";

/**
 * One student's submission: their work as turned in, the automatic checks, the rubric with
 * suggested levels, comments, sharing feedback and the official grade.
 */
export const SubmissionReviewPage = ({ teaching, assignmentId, submissionId }: { teaching: TeachingOffering; assignmentId: string; submissionId: string }) => {
  const offeringId = teaching.offering.id;
  const shelf = useRubricShelf();
  const [run, setRun] = useState<CheckRun | undefined>(undefined);
  const review = useLoad(`review:${submissionId}`, async (client) => {
    const [submissions, assignments, roster] = await Promise.all([
      client.call("teacher.listSubmissions", { params: { assignmentId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
      client.call("teacher.roster", { params: { offeringId } }),
    ]);
    const submission = submissions.find((s) => s.id === submissionId);
    if (submission === undefined) return undefined;
    const work = await Promise.all(submission.items.map((item) =>
      client.call("teacher.submittedContent", { params: { submissionId, artifactId: item.artifactId } })));
    return {
      submission,
      work,
      assignment: assignments.find((a) => a.id === assignmentId),
      student: roster.find((r) => r.enrollment.principalId === submission.studentPrincipalId)?.displayName ?? "This student",
    };
  });
  // Feedback and proposed grades change with every action on the page, so they reload on their own.
  const feedback = useLoad(`feedback:${submissionId}`, (client) => client.call("teacher.getFeedback", { params: { submissionId } }));
  const proposals = useLoad(`proposals:${assignmentId}`, (client) => client.call("teacher.pendingGrades", { params: { assignmentId } }));

  const back = <a href={routeHref({ screen: "submissions", offeringId, assignmentId })}>Back to submissions</a>;
  if (review.status === "loading") return <div className="flex flex-col gap-4">{back}<Loading label="Loading the submission…" /></div>;
  if (review.status === "error") return <div className="flex flex-col gap-4">{back}<Problem error={review.error} onRetry={review.reload} /></div>;
  if (review.data === undefined) {
    return <div className="flex flex-col gap-4">{back}<Text>This submission isn't part of this activity, or it was withdrawn.</Text></div>;
  }
  const { submission, work, assignment, student } = review.data;
  const rubric = submission.rubric === undefined ? undefined : shelf.rubrics.find((r) => r.rubricId === submission.rubric!.rubricId && r.version === submission.rubric!.version);
  const scores = feedback.status === "ready" ? feedback.data.scores : [];
  const criteria = reviewCriteria(rubric, run, scores);
  const excerpt = (comment: { anchor?: { artifactId: string; region: { kind: string; start?: number; end?: number } } }) => {
    const anchor = comment.anchor;
    if (anchor === undefined || anchor.region.kind !== "text-range") return undefined;
    const content = work.find((w) => w.item.artifactId === anchor.artifactId)?.content;
    return content?.kind === "text" ? content.text.slice(anchor.region.start, anchor.region.end) : undefined;
  };

  return (
    <div className="flex flex-col gap-6">
      {back}
      <PageHeading>{`${student}’s work · ${assignment?.title ?? "Activity"}`}</PageHeading>
      <p className="flex flex-wrap items-center gap-2">
        <Text as="span">{`Attempt ${submission.attempt}, turned in ${new Date(submission.submittedAt).toLocaleString()}`}</Text>
        {submission.timing === "late" ? <Badge variant="warning">Late</Badge> : <Badge variant="success">On time</Badge>}
      </p>

      <section aria-labelledby="work-heading" className="flex flex-col gap-3">
        <h2 id="work-heading"><Text variant="heading" as="span">Submitted work</Text></h2>
        {work.map((submitted, index) => (
          <SubmittedWork key={submitted.item.artifactId} submissionId={submissionId} submitted={submitted} index={index} onCommented={feedback.reload} />
        ))}
      </section>

      <DiscussionParticipation offeringId={offeringId} assignmentId={assignmentId} studentPrincipalId={submission.studentPrincipalId} student={student} />

      <CheckResults
        submissionId={submissionId}
        hasRubric={submission.rubric !== undefined}
        run={run}
        onRun={(result) => {
          setRun(result);
          feedback.reload();
        }}
      />

      {feedback.status === "loading" && <Loading label="Loading feedback…" />}
      {feedback.status === "error" && <Problem error={feedback.error} onRetry={feedback.reload} />}
      {feedback.status === "ready" && (
        <>
          <RubricScores submissionId={submissionId} criteria={criteria} scores={feedback.data.scores} onSaved={feedback.reload} />
          <FeedbackSharing submissionId={submissionId} feedback={feedback.data} excerpt={excerpt} onShared={feedback.reload} />
          <OfficialGrade
            submissionId={submissionId}
            student={student}
            suggestedTotal={teacherTotal(criteria, feedback.data.scores)}
            proposals={proposals.status === "ready" ? proposals.data.filter((p) => p.submissionId === submissionId) : []}
            onChanged={proposals.reload}
          />
        </>
      )}
    </div>
  );
};
