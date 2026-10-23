import { useState } from "react";
import { Badge, Banner, Button, Input, Radio, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { isLocal, SUBJECTS, type AuthoringDirectory } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Subject = (typeof SUBJECTS)[number][0];
const subjectName = (subject: string) => SUBJECTS.find(([id]) => id === subject)?.[1] ?? subject;

/** The course catalog: each course archived or restored, and a form for a new one. */
export const CoursesSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [course, setCourse] = useState<{ title: string; subject: Subject; gradeBand: string }>({ title: "", subject: "other", gradeBand: "" });
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
          aria-label="Add a course"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("create", async (client) => {
              const created = await client.call("admin.createCourse", { body: { title: course.title.trim(), subject: course.subject, gradeBand: course.gradeBand.trim() } });
              setCourse({ title: "", subject: "other", gradeBand: "" });
              return `Added ${created.title}.`;
            });
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input label="Course title" required value={course.title} onChange={(e) => setCourse({ ...course, title: e.target.value })} />
            <Input label="Grades" description="A grade such as 7, or a range such as 3-5." required value={course.gradeBand} onChange={(e) => setCourse({ ...course, gradeBand: e.target.value })} />
          </div>
          <Radio.Group legend="Subject" value={course.subject} onValueChange={(value) => setCourse({ ...course, subject: value as Subject })}>
            {SUBJECTS.map(([id, name]) => <Radio.Item key={id} value={id} label={name} />)}
          </Radio.Group>
          <div>
            <Button type="submit" variant="primary" loading={action.running("create")} disabled={course.title.trim() === "" || course.gradeBand.trim() === ""}>Add course</Button>
          </div>
        </form>
      )}
      {action.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Courses" description={action.error} />}
    </section>
  );
};
