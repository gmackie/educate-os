import { Banner, Button, LayerCard, Link, Table, Text } from "@cloudflare/kumo";
import { CloudSlashIcon } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { ClassroomGradeCell, ClassroomGradeColumn, ReadyClassroomGrades } from "../types.ts";
import { useLoad } from "../useLoad.ts";

const STATE_LABELS: Record<ClassroomGradeCell["state"], string> = {
  assigned: "Not turned in",
  "turned-in": "Turned in",
  returned: "Returned",
  reclaimed: "Unsubmitted",
};

const formatPoints = (points: number) => (Number.isInteger(points) ? String(points) : points.toFixed(2).replace(/0+$/, ""));

/** A cell's grade as Classroom holds it, out of the coursework's points where it has any. */
const gradeText = (cell: ClassroomGradeCell, column: ClassroomGradeColumn): string | undefined => {
  if (cell.assignedGrade === undefined) return undefined;
  return column.maxPoints === undefined ? formatPoints(cell.assignedGrade) : `${formatPoints(cell.assignedGrade)}/${formatPoints(column.maxPoints)}`;
};

/** A link into Classroom, opening in a new tab with no opener or referrer. */
const ClassroomLink = ({ href, children }: { href: string; children: string }) => (
  <Link href={href} target="_blank" rel="noopener noreferrer">
    {children}
    <Link.ExternalIcon />
    <span className="sr-only"> (opens in a new tab)</span>
  </Link>
);

/** The grades Classroom answered with: a student-by-coursework table, or why there is none. */
const ReadyGrades = ({ data, classLabel }: { data: ReadyClassroomGrades; classLabel: string }) => (
  <>
    <Text variant="secondary">
      Read-only. Grade and return work in Google Classroom; it keeps the grades.
      {data.courseLink === undefined ? null : (
        <>
          {" "}
          <ClassroomLink href={data.courseLink}>Open the class in Google Classroom</ClassroomLink>
        </>
      )}
    </Text>
    {data.courseWork.length === 0 || data.rows.length === 0 ? (
      <Text variant="secondary">
        {data.courseWork.length === 0 ? "No coursework in Google Classroom yet." : "No students linked to Google Classroom yet."}
      </Text>
    ) : (
      // Focusable, so a keyboard can scroll it sideways on a phone (WCAG 2.1.1).
      <LayerCard role="group" aria-label="Google Classroom grades" tabIndex={0} className="overflow-x-auto p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand">
        <Table>
          <caption className="sr-only">{`Google Classroom grades for ${classLabel}`}</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Student</Table.Head>
              {data.courseWork.map((column) => (
                <Table.Head key={column.courseWorkId}>
                  <span className="flex flex-col">
                    {column.link === undefined ? column.title : <ClassroomLink href={column.link}>{column.title}</ClassroomLink>}
                    <Text variant="secondary" size="sm" as="span">{column.maxPoints === undefined ? "Ungraded" : `out of ${formatPoints(column.maxPoints)}`}</Text>
                  </span>
                </Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {data.rows.map((row) => {
              const cells = new Map(row.cells.map((cell) => [cell.courseWorkId, cell]));
              return (
                <Table.Row key={row.studentPrincipalId}>
                  <Table.Head role="rowheader">{row.displayName}</Table.Head>
                  {data.courseWork.map((column) => {
                    const cell = cells.get(column.courseWorkId);
                    const grade = cell === undefined ? undefined : gradeText(cell, column);
                    return (
                      <Table.Cell key={column.courseWorkId}>
                        {cell === undefined ? (
                          <span><span aria-hidden>—</span><span className="sr-only">No submission</span></span>
                        ) : (
                          <span className="flex flex-col">
                            {grade === undefined ? null : <span>{grade}</span>}
                            <Text variant="secondary" size="sm" as="span">{STATE_LABELS[cell.state]}</Text>
                          </span>
                        )}
                      </Table.Cell>
                    );
                  })}
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      </LayerCard>
    )}
    {data.truncated ? <Text variant="secondary" size="sm">Showing the most recent Google Classroom coursework.</Text> : null}
  </>
);

/**
 * The class's grades as Google Classroom holds them (SCHO-403), read live and read-only: each
 * enrolled student's submission to each recent piece of coursework, its grade and whether it has
 * been returned. Classroom stays the record; a class with no Classroom connection shows nothing.
 */
export const ClassroomGrades = ({ offeringId, classLabel }: { offeringId: string; classLabel: string }) => {
  const grades = useLoad(`classroom-grades:${offeringId}`, (c) => c.call("teacher.classroomGrades", { params: { offeringId } }));
  if (grades.status === "loading") return null;
  if (grades.status === "ready" && grades.data.status === "not-connected") return null;

  return (
    <section aria-labelledby="classroom-grades" className="flex flex-col gap-3">
      <h2 id="classroom-grades"><Text variant="heading" as="span">From Google Classroom</Text></h2>
      {grades.status === "error" ? (
        <Problem error={grades.error} onRetry={grades.reload} />
      ) : grades.data.status === "unavailable" ? (
        <div role="status">
          <Banner
            variant="alert"
            icon={<CloudSlashIcon aria-hidden />}
            title="Google Classroom can't be reached right now"
            description="Grades there are unchanged. Try again in a little while."
            action={<Button size="sm" onClick={grades.reload}>Try again</Button>}
          />
        </div>
      ) : grades.data.status === "ready" ? (
        <ReadyGrades data={grades.data} classLabel={classLabel} />
      ) : null}
    </section>
  );
};
