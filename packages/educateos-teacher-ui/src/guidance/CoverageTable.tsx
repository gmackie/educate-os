import { Badge, Button, LayerCard, Table, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { MASTERY_LABELS, MASTERY_ORDER, STANDARD_STATE_TEXT } from "./practice.ts";

/** One standard's coverage row. */
export type CoverageRow = RouteResponse<"teacher.guidance">["coverage"][number];

const STATE_VARIANT = { approved: "success", hidden: "neutral", "not-approved": "warning", unmapped: "warning" } as const;
const FILL = {
  "needs-evidence": "bg-kumo-base",
  "encountered": "bg-kumo-info-tint",
  "practiced": "bg-kumo-warning-tint",
  "independent-reviewed": "bg-kumo-contrast",
} as const;

/**
 * Students per evidence state as a proportional bar. The bar is a picture of the counts below it:
 * every segment is also written out, with its number, in the legend, so no meaning rests on colour.
 */
export const MasteryBar = ({ code, mastery, roster }: { code: string; mastery: CoverageRow["mastery"]; roster: number }) => {
  const summary = MASTERY_ORDER.map((state) => `${mastery[state]} ${MASTERY_LABELS[state].toLowerCase()}`).join(", ");
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={`${code}, evidence by student, ${roster} students: ${summary}`} className="flex h-3 w-full min-w-32 overflow-hidden rounded border border-kumo-line">
        {MASTERY_ORDER.map((state) => mastery[state] === 0 || roster === 0 ? null : (
          <span key={state} data-state={state} className={`${FILL[state]} border-r border-kumo-line last:border-r-0`} style={{ width: `${(mastery[state] / roster) * 100}%` }} />
        ))}
      </div>
      <ul className="m-0 flex list-none flex-col p-0 text-sm" aria-label={`${code} evidence by student`}>
        {MASTERY_ORDER.map((state) => <li key={state}><strong>{mastery[state]}</strong> {MASTERY_LABELS[state].toLowerCase()}</li>)}
      </ul>
    </div>
  );
};

const pacing = (row: CoverageRow) => row.priority?.pacing === undefined ? undefined : `${row.priority.pacing.startsOn} to ${row.priority.pacing.endsOn}`;

/**
 * Coverage by standard. Opportunities (what was offered and chosen) and evidence by student (what
 * has been shared and reviewed) are separate columns with separate headings, and neither is
 * computed from the other: accepting or sharing an opportunity is never counted as mastery.
 */
export const CoverageTable = ({ rows, onOpen }: { rows: readonly CoverageRow[]; onOpen: (row: CoverageRow) => void }) => (
  <LayerCard className="overflow-x-auto p-0">
    <Table>
      <caption className="sr-only">Standards coverage for this class. Opportunities and evidence by student are counted separately.</caption>
      <Table.Header>
        <Table.Row>
          <Table.Head>Standard</Table.Head>
          <Table.Head>Opportunities (offered, accepted, shared, reviewed)</Table.Head>
          <Table.Head>Evidence by student (needs evidence, encountered, practiced, independent and teacher-reviewed)</Table.Head>
          <Table.Head>Details</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row) => (
          <Table.Row key={`${row.frameworkKey}:${row.competencyUri}`}>
            <Table.Cell>
              <div className="flex flex-col gap-1">
                <Text as="span" variant="heading">{row.code}</Text>
                <span>{row.statement}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={STATE_VARIANT[row.state]}>{STANDARD_STATE_TEXT[row.state]}</Badge>
                  {row.priority !== undefined && <Badge variant="info">{row.priority.level === "focus" ? "Focus standard" : "Supporting standard"}</Badge>}
                </div>
                {row.frameworkTitle !== undefined && (
                  <Text variant="secondary" size="sm">{[row.frameworkTitle, row.publisher, row.releaseVersion === undefined ? undefined : `release ${row.releaseVersion}`, row.provenance === undefined ? undefined : `catalog provenance: ${row.provenance}`].filter(Boolean).join(" · ")}</Text>
                )}
                {row.frameworkTitle === undefined && <Text variant="secondary" size="sm">No approved release to verify this against; nothing is inferred about it.</Text>}
                <Text variant="secondary" size="sm">{row.evidencePathway === "planner" ? "Students can share evidence here." : "No evidence pathway yet: students cannot share work for this standard in this build."}</Text>
                {pacing(row) !== undefined && <Text variant="secondary" size="sm">Pacing: {pacing(row)}</Text>}
                {row.priority?.discussionPrompt !== undefined && <Text variant="secondary" size="sm">Discussion prompt: {row.priority.discussionPrompt}</Text>}
              </div>
            </Table.Cell>
            <Table.Cell>
              <ul className="m-0 flex list-none flex-col p-0 text-sm" aria-label={`${row.code} opportunities`}>
                <li><strong>{row.opportunities.offered}</strong> offered</li>
                <li><strong>{row.opportunities.accepted}</strong> accepted</li>
                <li><strong>{row.opportunities.shared}</strong> shared</li>
                <li><strong>{row.opportunities.reviewed}</strong> reviewed</li>
              </ul>
              <Text variant="secondary" size="sm">Invitations and choices, not learning.</Text>
            </Table.Cell>
            <Table.Cell>
              <MasteryBar code={row.code} mastery={row.mastery} roster={row.roster} />
            </Table.Cell>
            <Table.Cell>
              <Button size="sm" onClick={() => onOpen(row)} aria-label={`View student evidence for ${row.code}`}>View student evidence</Button>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  </LayerCard>
);
