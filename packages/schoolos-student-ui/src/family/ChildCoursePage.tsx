import { Badge, Breadcrumbs, Empty, Surface, Text } from "@cloudflare/kumo";
import { ClipboardTextIcon } from "@phosphor-icons/react";
import type { RouteResponse } from "@schoolos/api-client";
import { FeedbackBody } from "../activity/FeedbackSection.tsx";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { childPath } from "../router.tsx";
import { classTitle, FamilyPrivacyNote } from "./ChildPage.tsx";

/** One assignment as a guardian sees it. */
type ChildAssignment = RouteResponse<"guardian.childCourse">["assignments"][number];

/** A grade as a family reads it, such as "8 of 10 points". */
const scoreText = ({ points, maxPoints }: { points: number; maxPoints: number }) => `${points} of ${maxPoints} points`;

const AssignmentItem = ({ entry, childName }: { entry: ChildAssignment; childName: string }) => {
  const { assignment, feedback, grades } = entry;
  const grade = grades.at(-1);
  const latest = feedback.at(-1);
  const headingId = `assignment-${assignment.id}`;
  return (
    <Surface as="section" aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <Text variant="heading" as="h2"><span id={headingId}>{assignment.title}</span></Text>
          <Text variant="secondary" size="sm">
            Due <time dateTime={assignment.dueAt}>{formatDateTime(assignment.dueAt)}</time>
          </Text>
        </div>
        {grade !== undefined ? (
          <Badge variant="success">{`Graded: ${scoreText(grade.score)}`}</Badge>
        ) : latest !== undefined ? (
          <Badge variant="info">Feedback shared</Badge>
        ) : null}
      </div>
      {latest === undefined ? (
        <Text variant="secondary">{`No feedback yet. It shows here once the teacher shares it with ${childName}.`}</Text>
      ) : (
        <FeedbackBody feedback={latest} reader="guardian" />
      )}
      {grade === undefined ? null : <Text>{`Official grade: ${scoreText(grade.score)}`}</Text>}
    </Surface>
  );
};

/**
 * One of a child's classes, for their guardian: each assignment with its due date, the feedback
 * the teacher has released to the child, as the child sees it, and the child's official grade. The
 * child's own work is never part of it.
 */
export const ChildCoursePage = ({ studentId, offeringId }: { studentId: string; offeringId: string }) => {
  const [page, reload] = useQuery(`child-course:${studentId}:${offeringId}`, async (api) => {
    const [children, course] = await Promise.all([
      api.call("guardian.listChildren"),
      api.call("guardian.childCourse", { params: { studentId, offeringId } }),
    ]);
    return { child: children.find((c) => c.studentPrincipalId === studentId), course };
  });

  if (page.status === "loading") return <LoadingSkeleton label="Loading this class" lines={4} />;
  if (page.status === "error") {
    return isNotFound(page.error)
      ? <Empty title="There's nothing here" description="Use My children to find your child's classes." />
      : <ErrorState error={page.error} title="We couldn't load this class" onRetry={reload} />;
  }
  const { child, course } = page.data;
  const childName = child?.displayName ?? "your child";
  const title = classTitle(course);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/family">My children</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={childPath(studentId)}>{childName}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{title}</Breadcrumbs.Current>
      </Breadcrumbs>
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">{title}</Text>
        <Text variant="secondary">{`${childName} · ${course.term.name}`}</Text>
        <FamilyPrivacyNote childName={childName} />
      </div>
      {course.assignments.length === 0 ? (
        <Empty size="sm" icon={<ClipboardTextIcon aria-hidden size={32} />} title="No assignments yet" description="The teacher hasn't assigned anything in this class yet." />
      ) : (
        <ul aria-label="Assignments" className="flex flex-col gap-3">
          {course.assignments.map((entry) => (
            <li key={entry.assignment.id}>
              <AssignmentItem entry={entry} childName={childName} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
