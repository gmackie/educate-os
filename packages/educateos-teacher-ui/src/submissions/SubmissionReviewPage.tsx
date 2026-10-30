import { useState } from "react";
import { Badge, Text } from "@cloudflare/kumo";
import { DistrictApiError } from "@educateos/api-client";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import type { CheckRun, RubricRelease, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { useSteadyLoad } from "../useSteadyLoad.ts";
import { CheckResults } from "./CheckResults.tsx";
import { FeedbackSharing } from "./FeedbackSharing.tsx";
import { OfficialGrade } from "./OfficialGrade.tsx";
import { reviewCriteria, teacherTotal } from "./rubricCriteria.ts";
import { RubricScores } from "./RubricScores.tsx";
import { SubmittedWork } from "./SubmittedWork.tsx";
import { workInStepOrder } from "./workSteps.ts";
import { DiscussionParticipation } from "../discussions/DiscussionParticipation.tsx";
import { formatDateTime } from "../dates.ts";

/** A rubric the district no longer has, or that isn't this class's to read, is reviewed without its criteria rather than failing the page. */
const missingAsUndefined = (error: unknown): undefined => {
  if (error instanceof DistrictApiError && error.code === "not-found") return undefined;
  throw error;
};

/** How many automatic checks a rubric's criteria hold. */
const rubricChecks = (rubric: RubricRelease): number => rubric.criteria.reduce((n, c) => n + c.checks.length, 0);

/**
 * One student's submission: their work as turned in, the automatic checks, the rubric with
 * suggested levels, comments, sharing feedback and the official grade.
 */
export const SubmissionReviewPage = ({ teaching, assignmentId, submissionId }: { teaching: TeachingOffering; assignmentId: string; submissionId: string }) => {
  const offeringId = teaching.offering.id;
  const [run, setRun] = useState<CheckRun | undefined>(undefined);
  const review = useLoad(`review:${submissionId}`, async (client) => {
    const [submissions, assignments, roster] = await Promise.all([
      client.call("teacher.listSubmissions", { params: { assignmentId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
      client.call("teacher.roster", { params: { offeringId } }),
    ]);
    const submission = submissions.find((s) => s.id === submissionId);
    if (submission === undefined) return undefined;
    const assignment = assignments.find((a) => a.id === assignmentId);
    const ref = submission.rubric;
    const [work, activity, rubric] = await Promise.all([
      Promise.all(submission.items.map((item) =>
        client.call("teacher.submittedContent", { params: { submissionId, artifactId: item.artifactId } }))),
      assignment === undefined ? undefined : client.call("teacher.getActivity", { params: { activityId: assignment.activityId } }),
      ref === undefined
        ? undefined
        : client.call("teacher.getRubric", { params: { offeringId, rubricId: ref.rubricId, version: String(ref.version) } }).catch(missingAsUndefined),
    ]);
    return {
      submission,
      work: workInStepOrder(work, assignment?.title ?? "", activity?.content),
      rubric,
      assignment,
      student: roster.find((r) => r.enrollment.principalId === submission.studentPrincipalId)?.displayName ?? "This student",
    };
  });
  // Feedback and proposed grades change with every action on the page, so they reload on their own.
  const feedback = useLoad(`feedback:${submissionId}`, (client) => client.call("teacher.getFeedback", { params: { submissionId } }));
  const proposals = useSteadyLoad(`proposals:${assignmentId}`, (client) => client.call("teacher.pendingGrades", { params: { assignmentId } }));
  const studentId = review.status === "ready" ? review.data?.submission.studentPrincipalId : undefined;
  const grades = useLoad(`grades:${assignmentId}:${studentId ?? ""}`, async (client) =>
    studentId === undefined ? [] : client.call("teacher.officialGrades", { params: { assignmentId, studentId } }));

  const back = <a href={routeHref({ screen: "submissions", offeringId, assignmentId })}>Back to submissions</a>;
  if (review.status === "loading") return <div className="flex flex-col gap-4">{back}<Loading label="Loading the submission…" /></div>;
  if (review.status === "error") return <div className="flex flex-col gap-4">{back}<Problem error={review.error} onRetry={review.reload} /></div>;
  if (review.data === undefined) {
    return <div className="flex flex-col gap-4">{back}<Text>This submission isn't part of this activity, or it was withdrawn.</Text></div>;
  }
  const { submission, work, rubric, assignment, student } = review.data;
  const scores = feedback.status === "ready" ? feedback.data.scores : [];
  const criteria = reviewCriteria(rubric, run, scores);
  const excerpt = (comment: { anchor?: { artifactId: string; region: { kind: string; start?: number; end?: number } } }) => {
    const anchor = comment.anchor;
    if (anchor === undefined || anchor.region.kind !== "text-range") return undefined;
    const content = work.find((w) => w.submitted.item.artifactId === anchor.artifactId)?.submitted.content;
    return content?.kind === "text" ? content.text.slice(anchor.region.start, anchor.region.end) : undefined;
  };

  return (
    <div className="flex flex-col gap-6">
      {back}
      <PageHeading>{`${student}’s work · ${assignment?.title ?? "Activity"}`}</PageHeading>
      <p className="flex flex-wrap items-center gap-2">
        <Text as="span">{`Attempt ${submission.attempt}, turned in ${formatDateTime(submission.submittedAt)}`}</Text>
        {submission.timing === "late" ? <Badge variant="warning">Late</Badge> : <Badge variant="success">On time</Badge>}
      </p>

      <section aria-labelledby="work-heading" className="flex flex-col gap-3">
        <h2 id="work-heading"><Text variant="heading" as="span">Submitted work</Text></h2>
        {work.map(({ submitted, label }) => (
          <SubmittedWork key={submitted.item.artifactId} submissionId={submissionId} submitted={submitted} label={label} onCommented={feedback.reload} />
        ))}
      </section>

      <DiscussionParticipation offeringId={offeringId} assignmentId={assignmentId} studentPrincipalId={submission.studentPrincipalId} student={student} />

      <CheckResults
        submissionId={submissionId}
        work={work}
        rubric={submission.rubric === undefined ? { kind: "none" } : rubric === undefined ? { kind: "unknown" } : { kind: "known", checks: rubricChecks(rubric) }}
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
          <RubricScores submissionId={submissionId} hasRubric={submission.rubric !== undefined} criteria={criteria} scores={feedback.data.scores} onSaved={feedback.reload} />
          <FeedbackSharing submissionId={submissionId} feedback={feedback.data} excerpt={excerpt} onShared={feedback.reload} />
          {proposals.data === undefined && proposals.error === undefined && <Loading label="Loading grade approvals…" />}
          {proposals.error !== undefined && <Problem error={proposals.error} onRetry={proposals.reload} />}
          {proposals.data !== undefined && proposals.error === undefined && <OfficialGrade
            submissionId={submissionId}
            student={student}
            suggestedTotal={teacherTotal(criteria, feedback.data.scores)}
            proposals={proposals.data.filter((p) => p.submissionId === submissionId)}
            official={grades.status === "ready" ? grades.data.at(-1) : undefined}
            officialLoading={grades.status === "loading"}
            onChanged={() => {
              proposals.reload();
              grades.reload();
            }}
          />}
          {grades.status === "error" && <Problem error={grades.error} onRetry={grades.reload} />}
        </>
      )}
    </div>
  );
};
