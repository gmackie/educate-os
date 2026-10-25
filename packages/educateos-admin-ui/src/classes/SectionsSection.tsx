import { useState } from "react";
import { Badge, Banner, Button, Input, LayerCard, Radio, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { isLocal, sectionLabel, type AuthoringDirectory } from "./authoring.ts";
import { SectionRoster } from "./SectionRoster.tsx";
import { useAuthoringAction } from "./useAuthoringAction.ts";

/**
 * Sections: one course taught in one school and term. Each can be archived, and opened to choose
 * its teachers and students. A district starts by naming its school.
 */
export const SectionsSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [open, setOpen] = useState<string>();
  const [school, setSchool] = useState({ name: "", gradeBands: "" });
  const [section, setSection] = useState({ schoolId: "", termId: "", courseId: "", sectionName: "" });
  const writable = isLocal(directory, "offering");
  const courses = directory.courses.filter((c) => c.archivedAt === undefined);
  const schoolId = directory.schools.length === 1 ? directory.schools[0]!.id : section.schoolId;

  return (
    <section aria-labelledby="sections-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="sections-heading">Sections</Text>
      {directory.schools.length === 0 && isLocal(directory, "school") && (
        <form
          aria-label="Name your school"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("school", async (client) => {
              const gradeBands = school.gradeBands.split(",").map((band) => band.trim()).filter((band) => band !== "");
              const created = await client.call("admin.createSchool", { body: { name: school.name.trim(), gradeBands } });
              return `Added ${created.name}.`;
            });
          }}
        >
          <Input label="School or co-op name" required value={school.name} onChange={(e) => setSchool({ ...school, name: e.target.value })} />
          <Input label="Grades" description="Such as K-8, or 6-8, 9-12." required value={school.gradeBands} onChange={(e) => setSchool({ ...school, gradeBands: e.target.value })} />
          <Button type="submit" variant="primary" loading={action.running("school")} disabled={school.name.trim() === "" || school.gradeBands.trim() === ""}>Add school</Button>
        </form>
      )}
      {directory.offerings.length === 0 ? <Text variant="secondary">No sections yet.</Text> : (
        <ul className="flex flex-col gap-2">
          {directory.offerings.map((offering) => {
            const label = sectionLabel(directory, offering);
            const archived = offering.archivedAt !== undefined;
            return (
              <li key={offering.id}>
                <LayerCard className="flex flex-col gap-3 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <Text variant="heading" as="h4">{label}</Text>
                      <Text variant="secondary" size="sm" as="span">{directory.terms.find((t) => t.id === offering.termId)?.name}</Text>
                      {archived && <Badge variant="neutral">Archived</Badge>}
                    </span>
                    <span className="flex gap-2">
                      <Button size="sm" aria-expanded={open === offering.id} onClick={() => setOpen(open === offering.id ? undefined : offering.id)}>
                        {open === offering.id ? "Hide people" : `People in ${label}`}
                      </Button>
                      {writable && (
                        <Button
                          size="sm"
                          aria-label={`${archived ? "Restore" : "Archive"} ${label}`}
                          loading={action.running(offering.id)}
                          disabled={action.busy}
                          onClick={() => void action.run(offering.id, async (client) => {
                            await client.call("admin.archiveOffering", { params: { offeringId: offering.id }, body: { archived: !archived } });
                            return archived ? `${label} is restored.` : `${label} is archived. Its people and work are kept.`;
                          })}
                        >
                          {archived ? "Restore" : "Archive"}
                        </Button>
                      )}
                    </span>
                  </div>
                  {open === offering.id && <SectionRoster directory={directory} offering={offering} />}
                </LayerCard>
              </li>
            );
          })}
        </ul>
      )}
      {writable && directory.schools.length > 0 && (
        directory.terms.length === 0 || courses.length === 0
          ? <Text variant="secondary">Add a term and a course to create a section.</Text>
          : (
            <form
              aria-label="Add a section"
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void action.run("create", async (client) => {
                  const created = await client.call("admin.createOffering", { body: { schoolId, termId: section.termId, courseId: section.courseId, sectionName: section.sectionName.trim() } });
                  setSection({ schoolId: "", termId: "", courseId: "", sectionName: "" });
                  return `Added ${sectionLabel(directory, created)}. Add its teacher and students next.`;
                });
              }}
            >
              {directory.schools.length > 1 && (
                <Radio.Group legend="School" value={section.schoolId} onValueChange={(v) => setSection({ ...section, schoolId: String(v) })}>
                  {directory.schools.map((s) => <Radio.Item key={s.id} value={s.id} label={s.name} />)}
                </Radio.Group>
              )}
              <Radio.Group legend="Course" value={section.courseId} onValueChange={(v) => setSection({ ...section, courseId: String(v) })}>
                {courses.map((c) => <Radio.Item key={c.id} value={c.id} label={c.title} />)}
              </Radio.Group>
              <Radio.Group legend="Term" value={section.termId} onValueChange={(v) => setSection({ ...section, termId: String(v) })}>
                {directory.terms.filter((t) => t.state !== "completed").map((t) => <Radio.Item key={t.id} value={t.id} label={t.name} />)}
              </Radio.Group>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <Input label="Section name" description="Such as Tuesday mornings or Period 2." required value={section.sectionName} onChange={(e) => setSection({ ...section, sectionName: e.target.value })} />
                <Button type="submit" variant="primary" loading={action.running("create")} disabled={schoolId === "" || section.termId === "" || section.courseId === "" || section.sectionName.trim() === ""}>
                  Add section
                </Button>
              </div>
            </form>
          )
      )}
      {action.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Sections" description={action.error} />}
    </section>
  );
};
