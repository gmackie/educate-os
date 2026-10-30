import { Badge, Table, Text } from "@cloudflare/kumo";
import { formatMoment } from "../app/labels.ts";
import { changeSummary, failureReason, modeName, type SyncRun } from "./rosterSync.ts";

const outcomeBadge = (run: SyncRun) => {
  if (run.outcome === "succeeded") return <Badge variant="success">Succeeded</Badge>;
  if (run.errorCode === "removal-held") return <Badge variant="warning">Held for approval</Badge>;
  return <Badge variant="error">Failed</Badge>;
};

/** The schools, terms and courses a run changed, together: they change rarely. */
const otherRecords = ({ schools, terms, courses }: SyncRun["counts"]) => ({
  added: schools.added + terms.added + courses.added,
  updated: schools.updated + terms.updated + courses.updated,
  deactivated: schools.deactivated + terms.deactivated + courses.deactivated,
});

/** The roster sync's recent runs, newest first, with what each changed or why it failed. */
export const RosterSyncHistory = ({ runs, provider }: {
  /** The runs, oldest first, as the district lists them. */
  runs: readonly SyncRun[];
  /** The roster provider's name, for failure reasons. */
  provider: string;
}) => (
  <section aria-labelledby="sync-history-heading" className="flex flex-col gap-3">
    <Text as="h3" variant="heading" id="sync-history-heading">Recent syncs</Text>
    {runs.length === 0 ? <Text variant="secondary">No roster sync has run yet.</Text> : (
      <div className="overflow-x-auto">
        <Table>
          <caption className="sr-only">Recent roster syncs, newest first</caption>
          <Table.Header>
            <Table.Row>
              <Table.Head>Started</Table.Head>
              <Table.Head>Sync</Table.Head>
              <Table.Head>Result</Table.Head>
              <Table.Head>People</Table.Head>
              <Table.Head>Classes</Table.Head>
              <Table.Head>Enrollments</Table.Head>
              <Table.Head>Schools, terms and courses</Table.Head>
              <Table.Head>Held for review</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {runs.toReversed().map((run) => (
              <Table.Row key={run.id}>
                <Table.Cell>{formatMoment(run.startedAt)}</Table.Cell>
                <Table.Cell>{modeName(run.mode)}</Table.Cell>
                <Table.Cell>
                  <div className="flex flex-col items-start gap-1">
                    {outcomeBadge(run)}
                    {run.errorCode !== undefined && <Text variant="secondary" size="sm">{failureReason(run.errorCode, provider)}</Text>}
                  </div>
                </Table.Cell>
                <Table.Cell>{changeSummary(run.counts.principals)}</Table.Cell>
                <Table.Cell>{changeSummary(run.counts.offerings)}</Table.Cell>
                <Table.Cell>{changeSummary(run.counts.enrollments)}</Table.Cell>
                <Table.Cell>{changeSummary(otherRecords(run.counts))}</Table.Cell>
                <Table.Cell>{run.quarantined === undefined ? "Not reached" : run.quarantined.toLocaleString("en-US")}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    )}
  </section>
);
