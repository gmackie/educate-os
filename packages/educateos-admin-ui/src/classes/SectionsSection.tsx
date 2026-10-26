import { useState } from "react";
import { Badge, Button, Input, LayerCard, Radio, Text } from "@cloudflare/kumo";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, sectionLabel, type AuthoringDirectory } from "./authoring.ts";
import { SectionRoster } from "./SectionRoster.tsx";
import { useAuthoringAction } from "./useAuthoringAction.ts";

/** The one choice there is to make, or what the administrator chose: a lone option starts chosen. */
const choiceOf = (chosen: string, options: readonly { id: string }[]): string => chosen !== "" ? chosen : options.length === 1 ? options[0]!.id : "";

/**
 * Sections: one course taught in one school and term. Each can be archived, and opened to choose
 * its teachers and students. The form asks for all three, starting with any that has one option.
 */
export const SectionsSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [open, setOpen] = useState<string>();
  const [section, setSection] = useState({ schoolId: "", termId: "", courseId: "", sectionName: "" });
  const writable = isLocal(directory, "offering");
  const courses = directory.courses.filter((c) => c.archivedAt === undefined);
  const terms = directory.terms.filter((t) => t.state !== "completed");
  const schoolId = choiceOf(section.schoolId, directory.schools);
  const courseId = choiceOf(section.courseId, courses);
  const termId = choiceOf(section.termId, terms);

  return (
    <section aria-labelledby="sections-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="sections-heading">Sections</Text>
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
                      <Text variant="secondary" size="sm" as="span">
                        {[directory.terms.find((t) => t.id === offering.termId)?.name, directory.schools.length > 1 ? directory.schools.find((s) => s.id === offering.schoolId)?.name : undefined]
                          .filter((part) => part !== undefined)
                          .join(" · ")}
                      </Text>
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
      {writable && (
        directory.schools.length === 0 || terms.length === 0 || courses.length === 0
          ? <Text variant="secondary">Add a school, a term and a course to create a section.</Text>
          : (
            <form
              aria-label="Add a section"
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void action.run("create", async (client) => {
                  const created = await client.call("admin.createOffering", { body: { schoolId, termId, courseId, sectionName: section.sectionName.trim() } });
                  setSection({ schoolId: "", termId: "", courseId: "", sectionName: "" });
                  return `Added ${sectionLabel(directory, created)}. Add its teacher and students next.`;
                });
              }}
            >
              <Radio.Group legend="School" value={schoolId} onValueChange={(v) => setSection({ ...section, schoolId: String(v) })}>
                {directory.schools.map((s) => <Radio.Item key={s.id} value={s.id} label={s.name} />)}
              </Radio.Group>
              <Radio.Group legend="Course" value={courseId} onValueChange={(v) => setSection({ ...section, courseId: String(v) })}>
                {courses.map((c) => <Radio.Item key={c.id} value={c.id} label={c.title} />)}
              </Radio.Group>
              <Radio.Group legend="Term" value={termId} onValueChange={(v) => setSection({ ...section, termId: String(v) })}>
                {terms.map((t) => <Radio.Item key={t.id} value={t.id} label={t.name} />)}
              </Radio.Group>
              <div className="max-w-sm">
                <Input label="Section name" description="Such as Tuesday mornings or Period 2." required value={section.sectionName} onChange={(e) => setSection({ ...section, sectionName: e.target.value })} />
              </div>
              <div>
                <Button type="submit" variant="primary" loading={action.running("create")} disabled={schoolId === "" || termId === "" || courseId === "" || section.sectionName.trim() === ""}>
                  Add section
                </Button>
              </div>
            </form>
          )
      )}
      <ActionOutcome outcome={action.outcome} title="Sections" />
    </section>
  );
};
