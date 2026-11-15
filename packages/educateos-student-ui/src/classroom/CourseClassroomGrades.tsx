import { Badge, Banner, Button, Table, Text } from "@cloudflare/kumo";
import { CloudSlashIcon } from "@phosphor-icons/react";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import type { ClassroomGrade } from "../model.ts";
import { SafeExternalLink } from "../SafeExternalLink.tsx";

const formatPoints = (points: number) => (Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/0+$/, ""));

const gradeText = ({ assignedGrade, maxPoints }: ClassroomGrade): string => {
  if (assignedGrade === undefined) return "No grade";
  return maxPoints === undefined ? formatPoints(assignedGrade) : `${formatPoints(assignedGrade)} out of ${formatPoints(maxPoints)}`;
};

/**
 * The student's own grades from Google Classroom for a class (SCHO-403): the work their teacher
 * returned there, read live and shown as Classroom has it. A class with no Classroom connection
 * shows nothing; Classroom being unreachable is said plainly without holding up the page.
 */
export const CourseClassroomGrades = ({ offeringId }: { offeringId: string }) => {
  const [grades, reload] = useQuery(`classroom-grades:${offeringId}`, async (api) => {
    try {
      return await api.call("student.classroomGrades", { params: { offeringId } });
    } catch (error) {
      // A class the student cannot read their grades in has nothing to show here.
      if (isNotFound(error)) return { status: "not-connected" as const };
      throw error;
    }
  });
  if (grades.status === "loading") return null;
  if (grades.status === "ready" && grades.data.status === "not-connected") return null;

  return (
    <section aria-labelledby="classroom-grades" className="flex flex-col gap-3">
      <Text variant="heading" as="h2">
        <span id="classroom-grades">From Google Classroom</span>
      </Text>
      {grades.status === "error" ? (
        <ErrorState error={grades.error} title="We couldn't load your Google Classroom grades" onRetry={reload} />
      ) : grades.data.status === "unavailable" ? (
        <div role="status">
          <Banner
            variant="alert"
            icon={<CloudSlashIcon aria-hidden />}
            title="Google Classroom can't be reached right now"
            description="Your grades there are safe. Try again in a little while."
            action={<Button size="sm" onClick={reload}>Try again</Button>}
          />
        </div>
      ) : grades.data.status === "ready" ? (
        <>
          <Text variant="secondary" size="sm">
            Grades your teacher returned in Google Classroom. Google Classroom keeps them; this is a read-only copy.
            {grades.data.courseLink === undefined ? null : (
              <>
                {" "}
                <SafeExternalLink href={grades.data.courseLink}>Open the class in Google Classroom</SafeExternalLink>
              </>
            )}
          </Text>
          {grades.data.grades.length === 0 ? (
            <Text variant="secondary">Nothing has been returned to you in Google Classroom yet.</Text>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-kumo-hairline">
              <Table>
                <caption className="sr-only">Grades returned in Google Classroom</caption>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Assignment</Table.Head>
                    <Table.Head>Grade</Table.Head>
                    <Table.Head>Status</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {grades.data.grades.map((grade) => (
                    <Table.Row key={grade.courseWorkId}>
                      <Table.Cell>{grade.link === undefined ? grade.title : <SafeExternalLink href={grade.link}>{grade.title}</SafeExternalLink>}</Table.Cell>
                      <Table.Cell>{gradeText(grade)}</Table.Cell>
                      <Table.Cell><Badge variant="success">Returned</Badge></Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            </div>
          )}
          {grades.data.truncated ? <Text variant="secondary" size="sm">Showing your most recent Google Classroom work.</Text> : null}
        </>
      ) : null}
    </section>
  );
};
