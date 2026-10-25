import { Badge, Empty, LayerCard, Table } from "@cloudflare/kumo";
import { UsersThree } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import type { TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";

/**
 * A class's students, whether each is enrolled, and how many of the class's activities each has
 * turned in. It shows class records only: a student's own space is theirs, and nothing here reads
 * or links to it.
 */
export const RosterPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const roster = useLoad(`roster:${offeringId}`, async (client) => {
    const [entries, assignments] = await Promise.all([
      client.call("teacher.roster", { params: { offeringId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
    ]);
    const submitted = await Promise.all(assignments.map(async (assignment) => {
      const submissions = await client.call("teacher.listSubmissions", { params: { assignmentId: assignment.id } });
      return new Set(submissions.filter((s) => s.withdrawnAt === undefined).map((s) => s.studentPrincipalId));
    }));
    const students = entries.filter((entry) => entry.enrollment.role === "student").map((entry) => ({
      entry,
      turnedIn: submitted.filter((who) => who.has(entry.enrollment.principalId)).length,
    }));
    return { students, activities: assignments.length };
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeading>{`Roster · ${classLabel(teaching)}`}</PageHeading>
      {roster.status === "loading" && <Loading label="Loading the roster…" />}
      {roster.status === "error" && <Problem error={roster.error} onRetry={roster.reload} />}
      {roster.status === "ready" && roster.data.students.length === 0 && (
        <Empty icon={<UsersThree size={32} aria-hidden />} title="No students yet" description="Students appear here once your district enrolls them in this class." />
      )}
      {roster.status === "ready" && roster.data.students.length > 0 && (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <caption className="sr-only">Students in {classLabel(teaching)}</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Student</Table.Head>
                <Table.Head>Enrollment</Table.Head>
                <Table.Head>Work turned in</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {roster.data.students.map(({ entry, turnedIn }) => (
                <Table.Row key={entry.enrollment.id}>
                  <Table.Cell>{entry.displayName}</Table.Cell>
                  <Table.Cell>
                    {entry.enrollment.status === "active"
                      ? <Badge variant="success" appearance="dot">Enrolled</Badge>
                      : <Badge variant="neutral" appearance="dot">No longer enrolled</Badge>}
                  </Table.Cell>
                  <Table.Cell>
                    {roster.data.activities === 0 ? "No activities yet" : `${turnedIn} of ${roster.data.activities} activities`}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </div>
  );
};
