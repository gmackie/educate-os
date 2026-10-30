import { Badge, Banner, Table, Text } from "@cloudflare/kumo";
import { CheckCircle, Info, Warning } from "@phosphor-icons/react";
import { count } from "../app/labels.ts";
import { RECORD_TYPES, failureReason, modeName, runSummary, type SyncRunResult } from "./rosterSync.ts";

type Preview = NonNullable<SyncRunResult["preview"]>;

/** Where in the feed an issue is: its file, row and column, as far as the issue says. */
const location = (issue: Preview["issues"][number]) =>
  [issue.file, issue.row === undefined ? undefined : `row ${issue.row}`, issue.column === undefined ? undefined : `column ${issue.column}`]
    .filter((part) => part !== undefined).join(", ") || "The whole feed";

/** The problems a sync found in the feed: errors that stopped it and records it skipped on purpose. */
const SyncIssues = ({ preview }: { preview: Preview }) => {
  const rows = [
    ...preview.issues.map((issue, index) => ({ key: `f${index}`, error: issue.severity === "error", where: location(issue), record: issue.sourcedId, message: issue.message })),
    ...preview.integrity.map((issue) => ({ key: `i:${issue.path}`, error: true, where: "The directory it would produce", record: undefined, message: issue.message })),
  ];
  return (
    <section aria-labelledby="sync-issues-heading" className="flex flex-col gap-2">
      <Text as="h4" variant="heading" id="sync-issues-heading">Issues ({rows.length})</Text>
      {rows.length === 0 ? <Text variant="secondary">The roster had no problems.</Text> : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Issues the sync found in the roster</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Severity</Table.Head>
                <Table.Head>Where</Table.Head>
                <Table.Head>Record</Table.Head>
                <Table.Head>Problem</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {rows.map((row) => (
                <Table.Row key={row.key}>
                  <Table.Cell>{row.error ? <Badge variant="error">Error</Badge> : <Badge variant="warning">Warning</Badge>}</Table.Cell>
                  <Table.Cell><Text variant="mono">{row.where}</Text></Table.Cell>
                  <Table.Cell>{row.record === undefined ? "" : <Text variant="mono">{row.record}</Text>}</Table.Cell>
                  <Table.Cell>{row.message}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
      )}
      {rows.some((row) => row.error) && <Text variant="secondary">Errors stop a sync: fix them in the roster, then sync again. Warnings are records the sync skipped on purpose.</Text>}
    </section>
  );
};

/**
 * What a sync an administrator just ran did: whether it applied, how each record type changed, and
 * the issues it found in the roster.
 */
export const RosterSyncResult = ({ result, provider }: {
  result: SyncRunResult;
  /** The roster provider's name, for failure reasons. */
  provider: string;
}) => {
  const { run, preview } = result;
  if (run === undefined) {
    return <Banner icon={<Info weight="fill" />} title="No sync ran" description="The district had no sync due. Choose complete or delta to run one now." />;
  }
  return (
    <section aria-labelledby="sync-result-heading" className="flex flex-col gap-4 rounded-lg border border-kumo-line p-4">
      <Text as="h3" variant="heading" id="sync-result-heading">{`${modeName(run.mode)} just now`}</Text>
      {run.outcome === "succeeded"
        ? <Banner icon={<CheckCircle weight="fill" />} title="The roster is up to date" description={runSummary(run, result.grantsRevoked)} />
        : run.errorCode === "removal-held"
          ? <Banner variant="alert" icon={<Warning weight="fill" />} title="This sync is waiting for approval" description={failureReason(run.errorCode, provider)} />
          : <Banner variant="error" icon={<Warning weight="fill" />} title="The sync failed" description={run.errorCode === undefined ? undefined : failureReason(run.errorCode, provider)} />}
      {run.outcome === "succeeded" && (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Records the sync added, updated and deactivated, by type</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Records</Table.Head>
                <Table.Head>Added</Table.Head>
                <Table.Head>Updated</Table.Head>
                <Table.Head>Deactivated</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {RECORD_TYPES.map(([key, label]) => (
                <Table.Row key={key}>
                  <Table.Cell>{label}</Table.Cell>
                  <Table.Cell>{run.counts[key].added.toLocaleString("en-US")}</Table.Cell>
                  <Table.Cell>{run.counts[key].updated.toLocaleString("en-US")}</Table.Cell>
                  <Table.Cell>{run.counts[key].deactivated.toLocaleString("en-US")}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <Text variant="secondary" size="sm">
            Roles: {count(run.counts.roleAssignments.added, "role")} granted, {count(run.counts.roleAssignments.removed, "role")} removed.
            Deactivated people and enrollments are kept, inactive, never deleted.
          </Text>
        </div>
      )}
      {preview !== undefined && <SyncIssues preview={preview} />}
    </section>
  );
};
