import { Badge, Empty, Link, Table, Text } from "@cloudflare/kumo";
import { ExamIcon } from "@phosphor-icons/react";
import { isNotFound, useQuery } from "./api.tsx";
import { groupCourses } from "./courses.ts";
import { ErrorState } from "./ErrorState.tsx";
import { courseTitle, formatDateTime } from "./labels.ts";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import type { Assignment, GradeMarker, GradeSummary, OfficialGrade } from "./model.ts";
import { activityPath, coursePath } from "./router.tsx";

interface CourseGrades {
  offeringId: string;
  title: string;
  past: boolean;
  rows: { assignment: Assignment; grade: OfficialGrade | undefined; marker: GradeMarker | undefined }[];
  /** The class's running total, or `undefined` for a class with no gradebook to read. */
  summary: GradeSummary | undefined;
}

const MARKER_LABELS: Record<GradeMarker, string> = { excused: "Excused", missing: "Missing", late: "Late" };

/** The class's running total and letter, as the teacher's gradebook settings compute them. */
const CourseTotal = ({ summary }: { summary: GradeSummary | undefined }) => {
  const final = summary?.row.totals.final ?? null;
  if (final === null) return <Text variant="secondary">No course grade yet.</Text>;
  const letter = summary!.row.totals.letter;
  return (
    <Text>
      <span className="font-semibold">{`Course grade: ${final.toFixed(1)}%`}</span>
      {letter === null ? null : <span>{` · ${letter}`}</span>}
    </Text>
  );
};

const CourseGradesTable = ({ course }: { course: CourseGrades }) => {
  const headingId = `grades-${course.offeringId}`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <Text variant="heading" as="h2">
        <span id={headingId} className="flex flex-wrap items-center gap-2">
          <Link href={coursePath(course.offeringId)} variant="plain">{course.title}</Link>
          {course.past ? <Badge variant="neutral">Finished</Badge> : null}
        </span>
      </Text>
      <CourseTotal summary={course.summary} />
      {course.rows.length === 0 ? (
        <Text variant="secondary">Nothing has been assigned in this class yet.</Text>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
          <Table>
            <caption className="sr-only">{`Grades for ${course.title}`}</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Activity</Table.Head>
                <Table.Head>Grade</Table.Head>
                <Table.Head>Recorded</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {course.rows.map(({ assignment, grade, marker }) => (
                <Table.Row key={assignment.id}>
                  <Table.Cell>
                    <Link href={activityPath(course.offeringId, assignment.id)}>{assignment.title}</Link>
                  </Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-wrap items-center gap-2">
                      {grade === undefined ? (
                        <Text variant="secondary" as="span">Not graded yet</Text>
                      ) : (
                        <>
                          {`${grade.score.points} out of ${grade.score.maxPoints}`}
                          {grade.version > 1 ? <Badge variant="info">Updated</Badge> : null}
                        </>
                      )}
                      {marker === undefined ? null : <Badge variant={marker === "missing" ? "warning" : "neutral"}>{MARKER_LABELS[marker]}</Badge>}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    {grade === undefined ? null : <time dateTime={grade.approval.approvedAt}>{formatDateTime(grade.approval.approvedAt)}</time>}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
    </section>
  );
};

/**
 * The student's official grades, class by class: the latest version of each, as their teacher
 * recorded it. Only official grades exist here; suggested scores and proposals never reach a
 * student, and criterion scores stay with each activity's feedback.
 */
export const GradesPage = () => {
  const [grades, reload] = useQuery("grades", async (api): Promise<CourseGrades[]> => {
    const [me, workspaces] = await Promise.all([api.call("me.get"), api.call("student.listWorkspaces")]);
    const { current, past } = groupCourses(me, workspaces);
    const courses = [...current.map((c) => ({ ...c, past: false })), ...past.map((c) => ({ ...c, past: true }))];
    return Promise.all(courses.map(async ({ offeringId, past: finished }) => {
      // A class the student can no longer see answers not-found, and has no grades to show here.
      const activities = await api.call("student.listActivities", { params: { offeringId } }).catch((error: unknown) => {
        if (isNotFound(error)) return [];
        throw error;
      });
      const [summary, rows] = await Promise.all([
        api.call("student.gradeSummary", { params: { offeringId } }).catch((error: unknown) => {
          if (isNotFound(error)) return undefined;
          throw error;
        }),
        Promise.all(activities.map(async ({ assignment }) => {
          const versions = await api.call("student.officialGrades", { params: { assignmentId: assignment.id } });
          return { assignment, grade: versions.at(-1) };
        })),
      ]);
      const markers = new Map(summary?.row.cells.map((cell) => [cell.assignmentId, cell.marker]));
      return {
        offeringId,
        title: courseTitle(activities),
        past: finished,
        summary,
        rows: rows.map((row) => ({ ...row, marker: markers.get(row.assignment.id) })).toSorted((a, b) => a.assignment.dueAt.localeCompare(b.assignment.dueAt)),
      };
    }));
  });

  if (grades.status === "loading") return <LoadingSkeleton label="Loading your grades" lines={4} />;
  if (grades.status === "error") return <ErrorState error={grades.error} title="We couldn't load your grades" onRetry={reload} />;
  const courses = grades.data;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">
          My grades
        </Text>
        <Text variant="secondary">The official grades your teachers have recorded, newest version of each, and each class's running total.</Text>
      </div>
      {courses.length === 0 ? (
        <Empty size="sm" icon={<ExamIcon aria-hidden size={32} />} title="No classes yet" description="When your teacher adds you to a class, its grades show up here." />
      ) : (
        courses.map((course) => <CourseGradesTable key={course.offeringId} course={course} />)
      )}
    </div>
  );
};
