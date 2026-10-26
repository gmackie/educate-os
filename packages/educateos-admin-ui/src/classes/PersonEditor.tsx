import { useState } from "react";
import { Button, Input, Radio } from "@cloudflare/kumo";
import type { Person } from "./authoring.ts";

/** The kinds of person the console adds and edits. Guardians and services come from elsewhere. */
export type EditableKind = "student" | "staff";

/** What the editor changes: only the fields that differ from the person as they are. */
export interface PersonChange {
  displayName?: string;
  email?: string | null;
  kind?: EditableKind;
}

/**
 * Corrects one person's name, email or kind (SCHO-212). Their sign-in is not editable: it is how
 * the district finds them. The district refuses a change of kind once they are in a section or
 * hold a role, and that refusal is shown beside the form by the caller.
 */
export const PersonEditor = ({ person, saving, onSave, onCancel }: {
  person: Person;
  saving: boolean;
  onSave: (change: PersonChange) => void;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState<{ displayName: string; email: string; kind: EditableKind }>({
    displayName: person.displayName,
    email: person.email ?? "",
    kind: person.kind === "staff" ? "staff" : "student",
  });
  const email = draft.email.trim();
  const change: PersonChange = {
    ...(draft.displayName.trim() === person.displayName ? {} : { displayName: draft.displayName.trim() }),
    ...(email === (person.email ?? "") ? {} : { email: email === "" ? null : email }),
    ...(draft.kind === person.kind ? {} : { kind: draft.kind }),
  };
  return (
    <form
      aria-label={`Edit ${person.displayName}`}
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(change);
      }}
    >
      <Radio.Group legend="Kind" value={draft.kind} onValueChange={(v) => setDraft({ ...draft, kind: v as EditableKind })}>
        <Radio.Item value="student" label="Student" />
        <Radio.Item value="staff" label="Staff (teachers, helpers and administrators)" />
      </Radio.Group>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Input label="Name" required value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
        <Input label="Email (optional)" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={draft.displayName.trim() === "" || Object.keys(change).length === 0}>Save changes</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};
