import { Button, Input, InputArea, Switch, Text } from "@cloudflare/kumo";
import { EyeSlash, Plus, Trash, Users } from "@phosphor-icons/react";
import type { NoteDraft } from "./activityForm.ts";

/**
 * Notes for the class context. Each has a "Teacher only" switch, and says in words beside it who
 * will read it, so a teacher never shares an answer or a private note by accident.
 */
export const ClassNotes = ({ notes, onChange }: { notes: readonly NoteDraft[]; onChange: (notes: NoteDraft[]) => void }) => {
  const update = (id: string, change: Partial<NoteDraft>) => onChange(notes.map((note) => (note.id === id ? { ...note, ...change } : note)));
  const nextId = () => `note-${notes.reduce((max, note) => Math.max(max, Number(note.id.slice("note-".length)) || 0), 0) + 1}`;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2"><Text variant="heading" as="span">Class notes</Text></legend>
      {notes.length === 0 && <Text variant="secondary">Add background, instructions or reminders for the class helper and students.</Text>}
      {notes.map((note, index) => (
        <div key={note.id} role="group" aria-label={`Note ${index + 1}`} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
          <Input label="Note title" value={note.title} onChange={(event) => update(note.id, { title: event.target.value })} />
          <InputArea label="Note" value={note.body} onValueChange={(body) => update(note.id, { body })} />
          <Switch label="Teacher only" checked={note.teacherOnly} onCheckedChange={(teacherOnly) => update(note.id, { teacherOnly })} />
          <p className="flex items-center gap-2" aria-live="polite">
            {note.teacherOnly
              ? <><EyeSlash aria-hidden /><Text as="span" bold>Teacher only: students never see this note.</Text></>
              : <><Users aria-hidden /><Text as="span">Students will see this note.</Text></>}
          </p>
          <Button variant="ghost" size="sm" icon={<Trash aria-hidden />} onClick={() => onChange(notes.filter((n) => n.id !== note.id))}>
            {`Remove note ${index + 1}`}
          </Button>
        </div>
      ))}
      <div>
        <Button icon={<Plus aria-hidden />} onClick={() => onChange([...notes, { id: nextId(), title: "", body: "", teacherOnly: false }])}>Add a note</Button>
      </div>
    </fieldset>
  );
};
