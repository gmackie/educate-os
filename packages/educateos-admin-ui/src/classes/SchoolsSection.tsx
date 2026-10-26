import { useState } from "react";
import { Button, Input, Link, Table, Text } from "@cloudflare/kumo";
import { schoolHref } from "../app/useHashRoute.ts";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, type AuthoringDirectory, type School } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

/** A school's name and grades as typed. */
export type SchoolDraft = { name: string; gradeBands: string };

/** The draft for `school`, or an empty one. */
export const draftOf = (school?: School): SchoolDraft => ({ name: school?.name ?? "", gradeBands: school?.gradeBands.join(", ") ?? "" });
/** The grade bands a draft lists. */
export const bandsOf = (draft: SchoolDraft) => draft.gradeBands.split(",").map((band) => band.trim()).filter((band) => band !== "");
/** Whether a draft names the school and at least one grade band. */
export const isComplete = (draft: SchoolDraft) => draft.name.trim() !== "" && bandsOf(draft).length > 0;

/** A school's name and grades, for adding one or correcting one. */
export const SchoolFields = ({ draft, onChange }: { draft: SchoolDraft; onChange: (draft: SchoolDraft) => void }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
    <Input label="School or co-op name" required value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
    <Input label="Grades" description="Such as K-8, or 6-8, 9-12." required value={draft.gradeBands} onChange={(e) => onChange({ ...draft, gradeBands: e.target.value })} />
  </div>
);

/** The district's schools, each correctable, and a form that adds another. A section belongs to one of them. */
export const SchoolsSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [adding, setAdding] = useState(draftOf());
  const [editing, setEditing] = useState<{ id: string; draft: SchoolDraft }>();
  const writable = isLocal(directory, "school");

  return (
    <section aria-labelledby="schools-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="schools-heading">Schools</Text>
      {directory.schools.length === 0 ? <Text variant="secondary">No schools yet. Name your school or co-op first: every section belongs to one.</Text> : (
        <Table>
          <caption className="sr-only">Schools</caption>
          <Table.Header><Table.Row><Table.Head>School</Table.Head><Table.Head>Grades</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {directory.schools.map((school) => (
              <Table.Row key={school.id}>
                <Table.Cell><Link href={schoolHref(school.id)}>{school.name}</Link></Table.Cell>
                <Table.Cell>{school.gradeBands.join(", ")}</Table.Cell>
                <Table.Cell>
                  {writable && (
                    <Button size="sm" variant="secondary" aria-label={`Edit ${school.name}`} disabled={action.busy} onClick={() => setEditing({ id: school.id, draft: draftOf(school) })}>
                      Edit
                    </Button>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
      {editing !== undefined && (
        <form
          aria-label="Edit a school"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("edit", async (client) => {
              const saved = await client.call("admin.updateSchool", { params: { schoolId: editing.id }, body: { name: editing.draft.name.trim(), gradeBands: bandsOf(editing.draft) } });
              setEditing(undefined);
              return `Saved ${saved.name}.`;
            });
          }}
        >
          <SchoolFields draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={action.running("edit")} disabled={!isComplete(editing.draft)}>Save school</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {writable && editing === undefined && (
        <form
          aria-label="Add a school"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("create", async (client) => {
              const created = await client.call("admin.createSchool", { body: { name: adding.name.trim(), gradeBands: bandsOf(adding) } });
              setAdding(draftOf());
              return `Added ${created.name}.`;
            });
          }}
        >
          <SchoolFields draft={adding} onChange={setAdding} />
          <div>
            <Button type="submit" variant={directory.schools.length === 0 ? "primary" : "secondary"} loading={action.running("create")} disabled={!isComplete(adding)}>Add school</Button>
          </div>
        </form>
      )}
      <ActionOutcome outcome={action.outcome} title="Schools" />
    </section>
  );
};
