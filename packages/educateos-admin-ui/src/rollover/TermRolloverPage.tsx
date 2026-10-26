import { useState } from "react";
import { Banner, Button, Select, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { count, formatDate } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type RolloverPreview = RouteResponse<"admin.termRollover">;
type Term = RouteResponse<"admin.authoring">["terms"][number];

const TERM_STATES: Record<RolloverPreview["termState"], string> = {
  planned: "Planned",
  active: "In progress",
  grading: "Being graded",
  completed: "Completed",
};

/**
 * A preview of closing a term: the learning spaces kept, the class access removed and the people
 * who lose live access, as counts. Previewing changes nothing.
 */
export const TermRolloverPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const terms = useLoad("rollover-terms", async (c) => (await c.call("admin.authoring")).terms);
  const [termId, setTermId] = useState<Term["id"] | null>(null);
  const [preview, setPreview] = useState<RolloverPreview>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const termName = (id: string) => (terms.status === "ready" ? terms.data.find((t) => t.id === id)?.name : undefined) ?? id;
  const run = async () => {
    if (termId === null) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await client.call("admin.termRollover", { params: { termId } });
      setPreview(result);
      announce("Term rollover preview ready.");
    } catch (e) {
      setPreview(undefined);
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">Term rollover preview</Text>
      <LoadState loaded={terms} what="the district's terms" onRetry={terms.reload}>
        {(list) => list.length === 0 ? <Text variant="secondary">The district has no terms yet.</Text> : (
          <form aria-label="Choose a term" className="flex max-w-md flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void run(); }}>
            <Select<Term["id"] | null>
              label="Term"
              placeholder="Choose a term"
              value={termId}
              renderValue={(id) => (id === null ? "Choose a term" : termName(id))}
              onValueChange={(id) => { setTermId(id); setPreview(undefined); }}
            >
              {list.map((t) => (
                <Select.Option key={t.id} value={t.id}>{`${t.name} (${formatDate(t.startsOn)} to ${formatDate(t.endsOn)}), ${TERM_STATES[t.state].toLowerCase()}`}</Select.Option>
              ))}
            </Select>
            <div><Button type="submit" variant="primary" disabled={termId === null} loading={loading}>Preview rollover</Button></div>
          </form>
        )}
      </LoadState>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Could not preview the rollover" description={error} />}
      {preview !== undefined && (
        <section aria-labelledby="rollover-result" className="flex flex-col gap-3">
          <Text as="h3" variant="heading" id="rollover-result">Closing {termName(preview.termId)}</Text>
          <Text>
            The term is {TERM_STATES[preview.termState].toLowerCase()}.{" "}
            {preview.alreadyClosed ? "It has already been closed." : preview.canClose ? "It can be closed now." : "It can be closed once it is completed."}
          </Text>
          <Table>
            <caption className="sr-only">What closing the term would change</caption>
            <Table.Body>
              <Table.Row><Table.Cell>Classes in the term</Table.Cell><Table.Cell>{preview.offerings}</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>Class learning spaces kept for the retention period</Table.Cell><Table.Cell>{preview.workspaces.toRetain}</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>Of those, on legal hold</Table.Cell><Table.Cell>{preview.workspaces.onLegalHold}</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>Class access grants removed</Table.Cell><Table.Cell>{preview.grants.toRevoke}</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>Students losing live class access</Table.Cell><Table.Cell>{preview.principals.students}</Table.Cell></Table.Row>
              <Table.Row><Table.Cell>Staff losing live class access</Table.Cell><Table.Cell>{preview.principals.staff}</Table.Cell></Table.Row>
            </Table.Body>
          </Table>
          <Text variant="secondary">{count(preview.principals.students + preview.principals.staff, "person", "people")} in total. Nothing anyone made is deleted.</Text>
        </section>
      )}
    </div>
  );
};
