import { useState } from "react";
import { Badge, Button, Input, Table, Text } from "@cloudflare/kumo";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { formatDate } from "../app/labels.ts";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, NEXT_TERM_STATE, type AuthoringDirectory, type Term } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

/** How each term state reads. */
export const STATE_LABEL = { planned: "Planned", active: "In session", grading: "Grading", completed: "Closed" } as const;

type TermDraft = { name: string; startsOn: string; endsOn: string };

const EMPTY: TermDraft = { name: "", startsOn: "", endsOn: "" };
const isComplete = (draft: TermDraft) => draft.name.trim() !== "" && draft.startsOn !== "" && draft.endsOn !== "";

/** A term's name and dates, for adding one or correcting one. */
const TermFields = ({ draft, onChange }: { draft: TermDraft; onChange: (draft: TermDraft) => void }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
    <Input label="Term name" required value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
    <Input label="Starts" type="date" required value={draft.startsOn} onChange={(e) => onChange({ ...draft, startsOn: e.target.value })} />
    <Input label="Ends" type="date" required value={draft.endsOn} onChange={(e) => onChange({ ...draft, endsOn: e.target.value })} />
  </div>
);

/**
 * The district's terms, each moved forward one step at a time and correctable, and a form for a
 * new one. A term only moves forward, so each step is confirmed first: the button that took it
 * would otherwise be replaced in place by the next step's, and a double click take both.
 */
export const TermsSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [adding, setAdding] = useState(EMPTY);
  const [editing, setEditing] = useState<{ id: string; draft: TermDraft }>();
  const [moving, setMoving] = useState<Term>();
  const writable = isLocal(directory, "term");
  const next = moving === undefined ? undefined : NEXT_TERM_STATE[moving.state];

  return (
    <section aria-labelledby="terms-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="terms-heading">Terms</Text>
      {directory.terms.length === 0 ? <Text variant="secondary">No terms yet.</Text> : (
        <Table>
          <caption className="sr-only">Terms</caption>
          <Table.Header><Table.Row><Table.Head>Term</Table.Head><Table.Head>Dates</Table.Head><Table.Head>State</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {directory.terms.map((t) => {
              const step = NEXT_TERM_STATE[t.state];
              return (
                <Table.Row key={t.id}>
                  <Table.Cell>{t.name}</Table.Cell>
                  <Table.Cell>{`${formatDate(t.startsOn)} to ${formatDate(t.endsOn)}`}</Table.Cell>
                  <Table.Cell><Badge variant={t.state === "active" ? "success" : "neutral"}>{STATE_LABEL[t.state]}</Badge></Table.Cell>
                  <Table.Cell>
                    {writable && (
                      <span className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Edit ${t.name}`}
                          disabled={action.busy}
                          onClick={() => setEditing({ id: t.id, draft: { name: t.name, startsOn: t.startsOn, endsOn: t.endsOn } })}
                        >
                          Edit
                        </Button>
                        {step !== undefined && (
                          <Button size="sm" aria-label={`${step.label}: ${t.name}`} loading={action.running(t.id)} disabled={action.busy} onClick={() => setMoving(t)}>
                            {step.label}…
                          </Button>
                        )}
                      </span>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
      <ConfirmDialog
        open={moving !== undefined && next !== undefined}
        title={moving === undefined || next === undefined ? "" : `${next.label}: ${moving.name}?`}
        confirmLabel={next?.label ?? ""}
        onCancel={() => setMoving(undefined)}
        onConfirm={() => {
          if (moving === undefined || next === undefined) return;
          setMoving(undefined);
          void action.run(moving.id, async (client) => {
            await client.call("admin.transitionTerm", { params: { termId: moving.id }, body: { to: next.to } });
            return `${moving.name} is now ${STATE_LABEL[next.to].toLowerCase()}.`;
          });
        }}
      >
        <p>{next?.consequence}</p>
      </ConfirmDialog>
      {editing !== undefined && (
        <form
          aria-label="Edit a term"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("edit", async (client) => {
              const saved = await client.call("admin.updateTerm", {
                params: { termId: editing.id },
                body: { name: editing.draft.name.trim(), startsOn: editing.draft.startsOn, endsOn: editing.draft.endsOn },
              });
              setEditing(undefined);
              return `Saved ${saved.name}.`;
            });
          }}
        >
          <TermFields draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={action.running("edit")} disabled={!isComplete(editing.draft)}>Save term</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {writable && editing === undefined && (
        <form
          aria-label="Add a term"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("create", async (client) => {
              const created = await client.call("admin.createTerm", { body: { name: adding.name.trim(), startsOn: adding.startsOn, endsOn: adding.endsOn } });
              setAdding(EMPTY);
              return `Added ${created.name}. Start it when classes begin.`;
            });
          }}
        >
          <TermFields draft={adding} onChange={setAdding} />
          <div>
            <Button type="submit" variant="primary" loading={action.running("create")} disabled={!isComplete(adding)}>Add term</Button>
          </div>
        </form>
      )}
      <ActionOutcome outcome={action.outcome} title="Terms" />
    </section>
  );
};
