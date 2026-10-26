import { useState } from "react";
import { Badge, Empty, LayerCard, Table, Text } from "@cloudflare/kumo";
import { ClipboardText, Tray } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import type { Assignment, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { DueDateEditor } from "./DueDateEditor.tsx";
import { formatDateTime } from "../dates.ts";

/** The class's assigned activities and, for the one chosen, every student's submitted work. */
export const SubmissionsPage = ({ teaching, assignmentId }: { teaching: TeachingOffering; assignmentId?: string }) => {
  const offeringId = teaching.offering.id;
  const assignments = useLoad(`assignments:${offeringId}`, (client) => client.call("teacher.listAssignments", { params: { offeringId } }));
  // Settings saved here, shown in place of the loaded ones without reloading the list (which would
  // take focus away from the form the teacher just used).
  const [edited, setEdited] = useState<Readonly<Record<string, Assignment>>>({});
  const list = assignments.status === "ready" ? assignments.data.map((a) => edited[a.id] ?? a) : [];
  const chosen = list.find((a) => a.id === assignmentId);
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Submissions · ${classLabel(teaching)}`}</PageHeading>
      {assignments.status === "loading" && <Loading label="Loading activities…" />}
      {assignments.status === "error" && <Problem error={assignments.error} onRetry={assignments.reload} />}
      {assignments.status === "ready" && list.length === 0 && (
        <Empty
          icon={<ClipboardText size={32} aria-hidden />}
          title="Nothing assigned yet"
          description="Publish an activity to this class and students' work will appear here."
          contents={<a href={routeHref({ screen: "create", offeringId })}>Create an activity</a>}
        />
      )}
      {assignments.status === "ready" && list.length > 0 && (
        <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
          <nav aria-label="Activities">
            <ul className="flex flex-col gap-1">
              {list.map((a) => (
                <li key={a.id}>
                  <a
                    href={routeHref({ screen: "submissions", offeringId, assignmentId: a.id })}
                    aria-current={a.id === assignmentId ? "page" : undefined}
                    className="flex flex-col rounded p-2 text-kumo-default no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand aria-[current=page]:bg-kumo-tint"
                  >
                    <Text bold as="span">{a.title}</Text>
                    <Text variant="secondary" size="sm" as="span">{`Due ${formatDateTime(a.dueAt)}`}</Text>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {assignmentId === undefined
            ? <Text variant="secondary">Choose an activity to see what students turned in.</Text>
            : (
              <div className="flex flex-col gap-6">
                {chosen !== undefined && (
                  <LayerCard className="p-4">
                    <DueDateEditor key={chosen.id} assignment={chosen} onChanged={(updated) => setEdited((previous) => ({ ...previous, [updated.id]: updated }))} />
                  </LayerCard>
                )}
                <SubmissionList offeringId={offeringId} assignmentId={assignmentId} title={chosen?.title ?? "This activity"} />
              </div>
            )}
        </div>
      )}
    </div>
  );
};

const SubmissionList = ({ offeringId, assignmentId, title }: { offeringId: string; assignmentId: string; title: string }) => {
  const list = useLoad(`submissions:${assignmentId}`, async (client) => {
    const [submissions, roster] = await Promise.all([
      client.call("teacher.listSubmissions", { params: { assignmentId } }),
      client.call("teacher.roster", { params: { offeringId } }),
    ]);
    const names = new Map(roster.map((entry) => [entry.enrollment.principalId as string, entry.displayName]));
    return submissions.filter((s) => s.withdrawnAt === undefined).map((submission) => ({ submission, name: names.get(submission.studentPrincipalId) ?? "A student" }));
  });
  return (
    <section aria-labelledby="submission-list-heading" className="flex flex-col gap-3">
      <h2 id="submission-list-heading"><Text variant="heading" as="span">{title}</Text></h2>
      {list.status === "loading" && <Loading label="Loading submissions…" />}
      {list.status === "error" && <Problem error={list.error} onRetry={list.reload} />}
      {list.status === "ready" && list.data.length === 0 && (
        <Empty size="sm" icon={<Tray size={28} aria-hidden />} title="No work turned in yet" description="Submissions appear here as students turn in their work." />
      )}
      {list.status === "ready" && list.data.length > 0 && (
        <LayerCard className="overflow-x-auto p-0">
          <Table>
            <caption className="sr-only">{`Work turned in for ${title}`}</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Student</Table.Head>
                <Table.Head>Attempt</Table.Head>
                <Table.Head>Turned in</Table.Head>
                <Table.Head><span className="sr-only">Review</span></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.data.map(({ submission, name }) => (
                <Table.Row key={submission.id}>
                  <Table.Cell>{name}</Table.Cell>
                  <Table.Cell>{submission.attempt}</Table.Cell>
                  <Table.Cell>
                    <span className="flex flex-wrap items-center gap-2">
                      {formatDateTime(submission.submittedAt)}
                      {submission.timing === "late" ? <Badge variant="warning">Late</Badge> : <Badge variant="success">On time</Badge>}
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <a href={routeHref({ screen: "review", offeringId, assignmentId, submissionId: submission.id })}>{`Review ${name}’s work`}</a>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </section>
  );
};
