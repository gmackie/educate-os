import { Badge, Button, Table, Text } from "@cloudflare/kumo";
import { formatMoment } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { TableScroll } from "../app/TableScroll.tsx";
import { channelLabel, EFFECT_LABELS, reasonLabel, words, type DecisionEntry } from "./decisionLabels.ts";
import type { DecisionPages } from "./useDecisionPages.ts";

const who = (entry: DecisionEntry) => entry.principalName ?? entry.principalId ?? "Unknown";

/**
 * A page of a decision log as a table, with the buttons that move between pages. Each row is one
 * decision: who asked, what for, the outcome and the rule that decided it, never what the record
 * held.
 */
export const DecisionTable = ({ pages, label, empty, what }: {
  pages: DecisionPages;
  /** The table's name, such as "Policy decisions, newest first". */
  label: string;
  /** What to say when the page lists nothing. */
  empty: string;
  /** What is loading, for the loading and error states. */
  what: string;
}) => (
  <LoadState loaded={pages.loaded} what={what} onRetry={pages.loaded.reload}>
    {({ entries }) => (
      <div className="flex flex-col gap-3">
        {entries.length === 0 ? (
          // Each page searches a bounded stretch of the log, so an empty one can have older matches.
          <Text variant="secondary">{pages.older === undefined ? empty : "Nothing matched in this stretch of the log. Older decisions may match."}</Text>
        ) : (
          <TableScroll label={label}>
            <Table>
              <caption className="sr-only">{label}</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>When</Table.Head>
                  <Table.Head>Who</Table.Head>
                  <Table.Head>Request</Table.Head>
                  <Table.Head>Outcome</Table.Head>
                  <Table.Head>Rule</Table.Head>
                  <Table.Head>Reference</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((entry) => (
                  <Table.Row key={entry.seq}>
                    <Table.Cell>{formatMoment(entry.decidedAt)}</Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col">
                        <Text>{who(entry)}</Text>
                        {entry.channel !== undefined && <Text variant="secondary" size="sm">{channelLabel(entry.channel)}</Text>}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col">
                        <Text>{[entry.action === undefined ? undefined : words(entry.action), entry.resourceKind === undefined ? undefined : words(entry.resourceKind).toLowerCase()].filter(Boolean).join(" ") || "Unreadable request"}</Text>
                        {entry.resourceId !== undefined && <Text variant="secondary" size="sm">{entry.resourceId}</Text>}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={EFFECT_LABELS[entry.effect].variant}>{EFFECT_LABELS[entry.effect].label}</Badge>
                        {entry.reason !== undefined && <Text variant="secondary" size="sm">{reasonLabel(entry.reason)}</Text>}
                      </div>
                    </Table.Cell>
                    <Table.Cell><span className="font-mono text-sm">{entry.ruleId}</span></Table.Cell>
                    <Table.Cell><span className="font-mono text-sm">{entry.correlationId}</span></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </TableScroll>
        )}
        {(pages.older !== undefined || pages.newer !== undefined) && (
          <nav aria-label={`${label}: pages`} className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={pages.newer === undefined} onClick={pages.newer}>Newer</Button>
            <Text variant="secondary" size="sm">{`Page ${pages.page}`}</Text>
            <Button size="sm" variant="secondary" disabled={pages.older === undefined} onClick={pages.older}>Older</Button>
          </nav>
        )}
      </div>
    )}
  </LoadState>
);
