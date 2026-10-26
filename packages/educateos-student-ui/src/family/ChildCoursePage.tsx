import { Badge, Empty, Link, Surface, Text } from "@cloudflare/kumo";
import { ArrowLeftIcon, ClipboardTextIcon } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { FeedbackBody } from "../activity/FeedbackSection.tsx";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { classTitle, formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { childPath } from "../router.tsx";
import { FamilyPrivacyNote } from "./ChildPage.tsx";
import { scoreText } from "./familyText.ts";

/** One assignment as a guardian sees it. */
type ChildAssignment = RouteResponse<"guardian.childCourse">["assignments"][number];
/** One of the class's announcements as a guardian sees it. */
type ChildAnnouncement = RouteResponse<"guardian.childCourse">["announcements"][number];

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
            {assignment.kind === "quiz" ? "Quiz · closes " : "Due "}
            <time dateTime={assignment.dueAt}>{formatDateTime(assignment.dueAt)}</time>
          </Text>
        </div>
        {grade !== undefined ? (
          <Badge variant="success">{`Official grade: ${scoreText(grade.score)}`}</Badge>
        ) : latest !== undefined ? (
          <Badge variant="info">Feedback shared</Badge>
        ) : null}
      </div>
      {latest !== undefined ? (
        <FeedbackBody feedback={latest} reader="guardian" />
      ) : assignment.kind === "quiz" ? (
        // A quiz is scored automatically: it has a score, not written feedback to wait for.
        grade === undefined ? <Text variant="secondary">{`The score shows here once the teacher releases it to ${childName}.`}</Text> : null
      ) : (
        <Text variant="secondary">{`No feedback yet. It shows here once the teacher shares it with ${childName}.`}</Text>
      )}
    </Surface>
  );
};

/** The class's announcements, newest first, exactly as the teacher wrote them (never as markup). */
const Announcements = ({ announcements }: { announcements: readonly ChildAnnouncement[] }) => (
  <section aria-labelledby="announcements" className="flex flex-col gap-3">
    <Text variant="heading" as="h2"><span id="announcements">Announcements</span></Text>
    <ul className="flex flex-col gap-3">
      {announcements.map((announcement) => (
        <li key={announcement.id}>
          <Surface as="article" aria-label={announcement.title} className="flex flex-col gap-1 rounded-lg border border-kumo-hairline p-4">
            <Text variant="heading" as="h3">{announcement.title}</Text>
            <Text variant="secondary" size="sm"><time dateTime={announcement.publishAt}>{formatDateTime(announcement.publishAt)}</time></Text>
            <p className="whitespace-pre-wrap">{announcement.body}</p>
          </Surface>
        </li>
      ))}
    </ul>
  </section>
);

/**
 * One of a child's classes, for their guardian: the class's announcements, each assignment with its
 * due date, the feedback the teacher has released to the child, as the child sees it, and the
 * child's official grade. The child's own work is never part of it.
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
      {/* One link back: the header already leads to My children, and the heading names the class. */}
      <Link href={childPath(studentId)} variant="plain" className="flex items-center gap-2 self-start">
        <ArrowLeftIcon aria-hidden />
        {`${childName}'s classes`}
      </Link>
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">{title}</Text>
        <Text variant="secondary">{`${childName} · ${course.term.name}`}</Text>
        <FamilyPrivacyNote childName={childName} />
      </div>
      {course.announcements.length === 0 ? null : <Announcements announcements={course.announcements} />}
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
