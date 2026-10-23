import { useState } from "react";
import { Badge, Banner, Button, Input, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { isLocal, NEXT_TERM_STATE, type AuthoringDirectory } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

const STATE_LABEL = { planned: "Planned", active: "In session", grading: "Grading", completed: "Closed" } as const;

/** The district's terms, each moved forward one step at a time, and a form for a new one. */
export const TermsSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [term, setTerm] = useState({ name: "", startsOn: "", endsOn: "" });
  const writable = isLocal(directory, "term");
  return (
    <section aria-labelledby="terms-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="terms-heading">Terms</Text>
      {directory.terms.length === 0 ? <Text variant="secondary">No terms yet.</Text> : (
        <Table>
          <caption className="sr-only">Terms</caption>
          <Table.Header><Table.Row><Table.Head>Term</Table.Head><Table.Head>Dates</Table.Head><Table.Head>State</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {directory.terms.map((t) => {
              const next = NEXT_TERM_STATE[t.state];
              return (
                <Table.Row key={t.id}>
                  <Table.Cell>{t.name}</Table.Cell>
                  <Table.Cell>{`${t.startsOn} to ${t.endsOn}`}</Table.Cell>
                  <Table.Cell><Badge variant={t.state === "active" ? "success" : "neutral"}>{STATE_LABEL[t.state]}</Badge></Table.Cell>
                  <Table.Cell>
                    {writable && next !== undefined && (
                      <Button
                        size="sm"
                        aria-label={`${next.label}: ${t.name}`}
                        loading={action.running(t.id)}
                        disabled={action.busy}
                        onClick={() => void action.run(t.id, async (client) => {
                          await client.call("admin.transitionTerm", { params: { termId: t.id }, body: { to: next.to } });
                          return `${t.name} is now ${STATE_LABEL[next.to].toLowerCase()}.`;
                        })}
                      >
                        {next.label}
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
      {writable && (
        <form
          aria-label="Add a term"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("create", async (client) => {
              const created = await client.call("admin.createTerm", { body: { name: term.name.trim(), startsOn: term.startsOn, endsOn: term.endsOn } });
              setTerm({ name: "", startsOn: "", endsOn: "" });
              return `Added ${created.name}. Start it when classes begin.`;
            });
          }}
        >
          <Input label="Term name" required value={term.name} onChange={(e) => setTerm({ ...term, name: e.target.value })} />
          <Input label="Starts" type="date" required value={term.startsOn} onChange={(e) => setTerm({ ...term, startsOn: e.target.value })} />
          <Input label="Ends" type="date" required value={term.endsOn} onChange={(e) => setTerm({ ...term, endsOn: e.target.value })} />
          <Button type="submit" variant="primary" loading={action.running("create")} disabled={term.name.trim() === "" || term.startsOn === "" || term.endsOn === ""}>Add term</Button>
        </form>
      )}
      {action.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Terms" description={action.error} />}
    </section>
  );
};
