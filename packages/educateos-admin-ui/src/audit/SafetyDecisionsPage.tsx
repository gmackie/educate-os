import { useState } from "react";
import { Badge, Button, Input, Select, Table, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { formatMoment } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { TableScroll } from "../app/TableScroll.tsx";
import { DecisionTable } from "./DecisionTable.tsx";
import { FILTER_KINDS, words } from "./decisionLabels.ts";
import { useDecisionPages } from "./useDecisionPages.ts";

type Outcome = "all" | "refused" | "held" | "allowed";
type Kind = (typeof FILTER_KINDS)[number];

const OUTCOMES: readonly [Outcome, string][] = [["all", "Every decision"], ["refused", "Refused"], ["held", "Held for approval"], ["allowed", "Allowed"]];
const outcomeName = (outcome: Outcome) => OUTCOMES.find(([value]) => value === outcome)![1];

/** What a rule filter must look like: a rule ID, or its prefix ending in a dot. */
const RULE = /^[a-z][a-z0-9.-]*$/;

/** The policy engine's decisions, filtered by outcome, rule and record kind. */
const PolicyDecisions = () => {
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [kind, setKind] = useState<Kind | null>(null);
  // The rule filter applies when submitted, not on each keystroke: every search is itself logged.
  const [ruleText, setRuleText] = useState("");
  const [rule, setRule] = useState("");
  const draft = ruleText.trim();
  const ruleValid = draft === "" || (RULE.test(draft) && draft.length <= 128);
  const pages = useDecisionPages("admin.decisionLog", {
    ...(outcome === "all" ? {} : { outcome }),
    ...(kind === null ? {} : { resourceKind: kind }),
    ...(rule === "" ? {} : { rule }),
  });
  return (
    <section aria-labelledby="policy-decisions" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="policy-decisions">Policy decisions</Text>
      <Text variant="secondary">
        Every request anyone makes is decided by the district's policy rules before it touches a record, and each decision is kept here: who asked, for what, the outcome and the rule.
        The log never holds what the record contained. It is append-only: nobody, administrators included, can change or remove an entry.
      </Text>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Select<Outcome>
          label="Outcome"
          className="min-w-48"
          value={outcome}
          renderValue={(value) => outcomeName(value)}
          onValueChange={(value) => setOutcome(value ?? "all")}
        >
          {OUTCOMES.map(([value, name]) => <Select.Option key={value} value={value}>{name}</Select.Option>)}
        </Select>
        <Select<Kind | null>
          label="Record"
          className="min-w-48"
          value={kind}
          renderValue={(value) => (value === null ? "Every kind" : words(value))}
          onValueChange={(value) => setKind(value)}
        >
          <Select.Option value={null}>Every kind</Select.Option>
          {FILTER_KINDS.map((value) => <Select.Option key={value} value={value}>{words(value)}</Select.Option>)}
        </Select>
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ruleValid) setRule(draft);
          }}
        >
          <Input
            label="Rule"
            description="A rule ID, or the start of one ending in a dot, such as discussion."
            className="font-mono"
            value={ruleText}
            onChange={(event) => setRuleText(event.target.value)}
            {...(ruleValid ? {} : { error: "Use lowercase letters, digits, dots and dashes, as rule IDs are written." })}
          />
          <Button type="submit" variant="secondary" disabled={!ruleValid}>Filter</Button>
        </form>
      </div>
      <DecisionTable pages={pages} label="Policy decisions, newest first" what="the policy decisions" empty="No decision matches these filters." />
    </section>
  );
};

type Screening = RouteResponse<"admin.screeningLog">;

const SCREENING_MODES: Readonly<Record<Screening["screening"], string>> = {
  "hall-monitor": "Hall Monitor screens every student post before it is shared.",
  "held-for-teachers": "Hall Monitor is not set up here, so every student post waits for a teacher's approval instead.",
  "published-unscreened": "Hall Monitor is not set up here, and student posts are published unscreened. Only the synthetic demo districts run this way.",
};

const DECISIONS: Readonly<Record<Screening["entries"][number]["decision"], { label: string; variant: "error" | "warning" | "neutral" }>> = {
  refused: { label: "Refused", variant: "error" },
  hold: { label: "Held for a teacher", variant: "warning" },
  coach: { label: "Shown with a concern", variant: "neutral" },
};

const POST_STATUS: Readonly<Record<NonNullable<Screening["entries"][number]["postStatus"]>, string>> = {
  visible: "Shown to the class",
  pending: "Waiting for a teacher",
  hidden: "Hidden by a teacher",
  removed: "Removed by a teacher",
};

/** Hall Monitor's decisions on students' discussion posts, across the district. */
const HallMonitorScreening = () => {
  const screening = useLoad("screening-log", (client) => client.call("admin.screeningLog"));
  return (
    <section aria-labelledby="hall-monitor" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="hall-monitor">Hall Monitor: discussion posts</Text>
      <LoadState loaded={screening} what="Hall Monitor's decisions" onRetry={screening.reload}>
        {({ screening: mode, entries, truncated }) => (
          <>
            <Text variant="secondary">
              {SCREENING_MODES[mode]} The log shows Hall Monitor's decision and reason codes, never the post itself.
              Hall Monitor's checks on AI conversations are made by the AI call guard, which keeps no per-message record in the district, so they are not listed here.
            </Text>
            {entries.length === 0 ? <Text variant="secondary">Hall Monitor has refused, held or flagged no post.</Text> : (
              <TableScroll label="Hall Monitor decisions, newest first">
                <Table>
                  <caption className="sr-only">Hall Monitor decisions, newest first</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>When</Table.Head>
                      <Table.Head>Class</Table.Head>
                      <Table.Head>Student</Table.Head>
                      <Table.Head>Decision</Table.Head>
                      <Table.Head>Reasons</Table.Head>
                      <Table.Head>Post now</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {entries.map((entry, index) => (
                      <Table.Row key={`${entry.at}-${index}`}>
                        <Table.Cell>{formatMoment(entry.at)}</Table.Cell>
                        <Table.Cell>{entry.offeringName}</Table.Cell>
                        <Table.Cell>{entry.authorName ?? entry.authorId ?? "Unknown"}</Table.Cell>
                        <Table.Cell><Badge variant={DECISIONS[entry.decision].variant}>{DECISIONS[entry.decision].label}</Badge></Table.Cell>
                        <Table.Cell><span className="font-mono text-sm">{entry.reasonCodes.join(", ") || "None given"}</span></Table.Cell>
                        <Table.Cell>{entry.postStatus === undefined ? "Never shared" : POST_STATUS[entry.postStatus]}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </TableScroll>
            )}
            {truncated && <Text variant="secondary" size="sm">Only the most recent decisions are listed.</Text>}
          </>
        )}
      </LoadState>
    </section>
  );
};

/**
 * The safety decision log (SCHO-376): what the district's policy engine decided for every request,
 * and what Hall Monitor decided about students' discussion posts. Read-only.
 */
export const SafetyDecisionsPage = () => (
  <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-1">
      <Text as="h2" variant="heading" size="lg">Safety decisions</Text>
      <Text variant="secondary">What the district's safety controls decided, for review. Only district administrators can read this page, and reading it is logged too.</Text>
    </div>
    <PolicyDecisions />
    <HallMonitorScreening />
  </div>
);
