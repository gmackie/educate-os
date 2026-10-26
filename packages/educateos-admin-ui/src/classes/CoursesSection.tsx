import { useState } from "react";
import { Badge, Button, Input, Select, Table, Text } from "@cloudflare/kumo";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, SUBJECTS, type AuthoringDirectory, type Course } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Subject = (typeof SUBJECTS)[number][0];
const subjectName = (subject: string) => SUBJECTS.find(([id]) => id === subject)?.[1] ?? subject;

// No subject is chosen until the administrator picks one: a default of "Other" was kept by
// accident more often than chosen.
type CourseDraft = { title: string; subject: Subject | null; gradeBand: string };

const EMPTY: CourseDraft = { title: "", subject: null, gradeBand: "" };
const isComplete = (draft: CourseDraft): draft is CourseDraft & { subject: Subject } =>
  draft.title.trim() !== "" && draft.gradeBand.trim() !== "" && draft.subject !== null;

/** A course's title, grades and subject, for adding one or correcting one. */
const CourseFields = ({ draft, onChange }: { draft: CourseDraft; onChange: (draft: CourseDraft) => void }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
    <Input label="Course title" required value={draft.title} onChange={(e) => onChange({ ...draft, title: e.target.value })} />
    <Input label="Grades" description="A grade such as 7, or a range such as 3-5." required value={draft.gradeBand} onChange={(e) => onChange({ ...draft, gradeBand: e.target.value })} />
    <Select<Subject | null>
      label="Subject"
      required
      className="min-w-56"
      placeholder="Choose a subject"
      value={draft.subject}
      renderValue={(value) => (value === null ? "Choose a subject" : subjectName(value))}
      onValueChange={(value) => onChange({ ...draft, subject: value })}
    >
      {SUBJECTS.map(([id, name]) => <Select.Option key={id} value={id}>{name}</Select.Option>)}
    </Select>
  </div>
);

/** The course catalog: each course corrected, archived or restored, and a form for a new one. */
export const CoursesSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [adding, setAdding] = useState(EMPTY);
  const [editing, setEditing] = useState<{ course: Course; draft: CourseDraft }>();
  const writable = isLocal(directory, "course");
  return (
    <section aria-labelledby="courses-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="courses-heading">Courses</Text>
      {directory.courses.length === 0 ? <Text variant="secondary">No courses yet.</Text> : (
        <Table>
          <caption className="sr-only">Courses</caption>
          <Table.Header><Table.Row><Table.Head>Course</Table.Head><Table.Head>Subject</Table.Head><Table.Head>Grades</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
          <Table.Body>
            {directory.courses.map((c) => {
              const archived = c.archivedAt !== undefined;
              return (
                <Table.Row key={c.id}>
                  <Table.Cell>
                    <span className="flex items-center gap-2">{c.title}{archived && <Badge variant="neutral">Archived</Badge>}</span>
                  </Table.Cell>
                  <Table.Cell>{subjectName(c.subject)}</Table.Cell>
                  <Table.Cell>{c.gradeBand}</Table.Cell>
                  <Table.Cell>
                    {writable && (
                      <span className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Edit ${c.title}`}
                          disabled={action.busy}
                          onClick={() => setEditing({ course: c, draft: { title: c.title, subject: c.subject as Subject, gradeBand: c.gradeBand } })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          aria-label={`${archived ? "Restore" : "Archive"} ${c.title}`}
                          loading={action.running(c.id)}
                          disabled={action.busy}
                          onClick={() => void action.run(c.id, async (client) => {
                            await client.call("admin.archiveCourse", { params: { courseId: c.id }, body: { archived: !archived } });
                            return archived ? `${c.title} is restored.` : `${c.title} is archived. Its sections and work are kept.`;
                          })}
                        >
                          {archived ? "Restore" : "Archive"}
                        </Button>
                      </span>
                    )}
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
      {editing !== undefined && (
        <form
          aria-label={`Edit ${editing.course.title}`}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const { draft } = editing;
            if (!isComplete(draft)) return;
            void action.run("edit", async (client) => {
              const saved = await client.call("admin.updateCourse", {
                params: { courseId: editing.course.id },
                body: { title: draft.title.trim(), subject: draft.subject, gradeBand: draft.gradeBand.trim() },
              });
              setEditing(undefined);
              return `Saved ${saved.title}.`;
            });
          }}
        >
          <CourseFields draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={action.running("edit")} disabled={!isComplete(editing.draft)}>Save course</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      {writable && editing === undefined && (
        <form
          aria-label="Add a course"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isComplete(adding)) return;
            const { subject } = adding;
            void action.run("create", async (client) => {
              const created = await client.call("admin.createCourse", { body: { title: adding.title.trim(), subject, gradeBand: adding.gradeBand.trim() } });
              setAdding(EMPTY);
              return `Added ${created.title}.`;
            });
          }}
        >
          <CourseFields draft={adding} onChange={setAdding} />
          <div>
            <Button type="submit" variant="primary" loading={action.running("create")} disabled={!isComplete(adding)}>Add course</Button>
          </div>
        </form>
      )}
      <ActionOutcome outcome={action.outcome} title="Courses" />
    </section>
  );
};
