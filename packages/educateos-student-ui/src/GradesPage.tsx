import { Badge, Empty, Link, Table, Text } from "@cloudflare/kumo";
import { ExamIcon } from "@phosphor-icons/react";
import type { DistrictApiClient } from "@educateos/api-client";
import { isNotFound, useQuery } from "./api.tsx";
import { groupCourses } from "./courses.ts";
import { ErrorState } from "./ErrorState.tsx";
import { classTitleIn, formatDateTime } from "./labels.ts";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import type { GradeMarker, GradeSummary, OfficialGrade } from "./model.ts";
import { activityPath, coursePath, quizPath } from "./router.tsx";

/** One graded piece of work in a class: an activity, a quiz, or anything else the gradebook counts. */
interface GradeRow {
  assignmentId: string;
  title: string;
  dueAt: string;
  /** Where the work is opened, or `undefined` for work with no screen here. */
  href: string | undefined;
  grade: OfficialGrade | undefined;
  marker: GradeMarker | undefined;
}

interface CourseGrades {
  offeringId: string;
  title: string;
  past: boolean;
  rows: GradeRow[];
  /** The class's running total, or `undefined` for a class with no gradebook to read. */
  summary: GradeSummary | undefined;
}

const MARKER_LABELS: Record<GradeMarker, string> = { excused: "Excused", missing: "Missing", late: "Late" };

/** A read the student may no longer make (a class they left) as nothing, rather than a failure. */
const orNothing = <T,>(read: Promise<T>, nothing: T): Promise<T> =>
  read.catch((error: unknown) => {
    if (isNotFound(error)) return nothing;
    throw error;
  });

/**
 * A class's graded work. The gradebook's columns are every assignment its total counts, quizzes
 * included, so the rows add up to the total; activities and quizzes link to their screens. A class
 * without a gradebook to read falls back to its activities.
 */
const loadCourse = async (api: DistrictApiClient, offeringId: string, title: string, past: boolean): Promise<CourseGrades> => {
  const [activities, quizzes, summary] = await Promise.all([
    orNothing(api.call("student.listActivities", { params: { offeringId } }), []),
    orNothing(api.call("student.listQuizzes", { params: { offeringId } }), []),
    orNothing(api.call("student.gradeSummary", { params: { offeringId } }), undefined),
  ]);
  const hrefOf = (assignmentId: string): string | undefined => {
    if (activities.some((a) => a.assignment.id === assignmentId)) return activityPath(offeringId, assignmentId);
    const quiz = quizzes.find((q) => q.assignmentId === assignmentId);
    return quiz === undefined ? undefined : quizPath(offeringId, quiz.id);
  };
  const columns = summary?.columns ?? activities.map(({ assignment }) => ({ assignmentId: assignment.id, title: assignment.title, dueAt: assignment.dueAt }));
  const markers = new Map(summary?.row.cells.map((cell) => [cell.assignmentId, cell.marker]));
  const rows = await Promise.all(columns.map(async ({ assignmentId, title: workTitle, dueAt }) => {
    const versions = await api.call("student.officialGrades", { params: { assignmentId } });
    return { assignmentId, title: workTitle, dueAt, href: hrefOf(assignmentId), grade: versions.at(-1), marker: markers.get(assignmentId) };
  }));
  return { offeringId, title, past, summary, rows: rows.toSorted((a, b) => a.dueAt.localeCompare(b.dueAt)) };
};

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
                <Table.Head>Work</Table.Head>
                <Table.Head>Grade</Table.Head>
                <Table.Head>Recorded</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {course.rows.map(({ assignmentId, title, href, grade, marker }) => (
                <Table.Row key={assignmentId}>
                  <Table.Cell>{href === undefined ? title : <Link href={href}>{title}</Link>}</Table.Cell>
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
 * recorded it, for every piece of work the class's total counts. Only official grades exist here;
 * suggested scores and proposals never reach a student, and criterion scores stay with each
 * activity's feedback.
 */
export const GradesPage = () => {
  const [grades, reload] = useQuery("grades", async (api): Promise<CourseGrades[]> => {
    const [me, workspaces, offerings] = await Promise.all([api.call("me.get"), api.call("student.listWorkspaces"), api.call("student.listOfferings")]);
    const { current, past } = groupCourses(me, workspaces);
    const courses = [...current.map((c) => ({ ...c, past: false })), ...past.map((c) => ({ ...c, past: true }))];
    return Promise.all(courses.map(({ offeringId, past: finished }) => loadCourse(api, offeringId, classTitleIn(offerings, offeringId), finished)));
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
