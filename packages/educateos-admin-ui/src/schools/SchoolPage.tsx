import { useState } from "react";
import { Badge, Breadcrumbs, Button, Empty, Table, Text } from "@cloudflare/kumo";
import { Buildings } from "@phosphor-icons/react";
import type { DistrictApiClient, RouteResponse } from "@educateos/api-client";
import { count, formatDate } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { ActionOutcome } from "../classes/ActionOutcome.tsx";
import { isLocal, type School, type Term } from "../classes/authoring.ts";
import { bandsOf, draftOf, isComplete, SchoolFields, type SchoolDraft } from "../classes/SchoolsSection.tsx";
import { STATE_LABEL } from "../classes/TermsSection.tsx";
import { useAuthoringAction } from "../classes/useAuthoringAction.ts";

type DistrictClass = RouteResponse<"admin.listOfferings">[number];

/** A person in the school, and the classes they are in. */
interface Member {
  name: string;
  classes: string[];
}

/** One school as its page shows it. */
interface SchoolView {
  school: School;
  /** Whether the district, rather than a roster system, owns its schools, so the page may edit this one. */
  editable: boolean;
  classes: { row: DistrictClass; term: Term | undefined }[];
  terms: Term[];
  staff: Member[];
  students: Member[];
}

const title = (c: DistrictClass) => `${c.course.title} · ${c.offering.sectionName}`;

/** Gathers each person once, with the classes they are actively in. */
const members = (entries: { name: string; className: string }[]): Member[] => {
  const byName = new Map<string, string[]>();
  for (const { name, className } of entries) byName.set(name, [...byName.get(name) ?? [], className]);
  return [...byName].map(([name, classes]) => ({ name, classes })).toSorted((a, b) => a.name.localeCompare(b.name));
};

const loadSchool = async (client: DistrictApiClient, schoolId: string): Promise<SchoolView | undefined> => {
  const [directory, listed] = await Promise.all([client.call("admin.authoring"), client.call("admin.listOfferings")]);
  const school = directory.schools.find((s) => s.id === schoolId);
  if (school === undefined) return undefined;
  const here = listed.filter((c) => c.offering.schoolId === schoolId && c.offering.archivedAt === undefined).toSorted((a, b) => title(a).localeCompare(title(b)));
  const rosters = await Promise.all(here.map((c) => client.call("admin.offeringRoster", { params: { offeringId: c.offering.id } })));
  const active = rosters.flatMap((roster, i) => roster
    .filter((entry) => entry.enrollment.status === "active")
    .map((entry) => ({ role: entry.enrollment.role, name: entry.displayName, className: title(here[i]!) })));
  const terms = directory.terms.filter((t) => here.some((c) => c.offering.termId === t.id)).toSorted((a, b) => b.startsOn.localeCompare(a.startsOn));
  return {
    school,
    editable: isLocal(directory, "school"),
    classes: here.map((row) => ({ row, term: directory.terms.find((t) => t.id === row.offering.termId) })),
    terms,
    staff: members(active.filter((e) => e.role !== "student")),
    students: members(active.filter((e) => e.role === "student")),
  };
};

/** The school's name and grades, and correcting them, where the district owns its schools. */
const SchoolHeading = ({ view, onChanged }: { view: SchoolView; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [editing, setEditing] = useState<SchoolDraft>();
  const { school } = view;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Text as="h2" variant="heading" size="lg">{school.name}</Text>
          <Text variant="secondary">{`Grades ${school.gradeBands.join(", ")}`}</Text>
        </div>
        {view.editable && editing === undefined && (
          <Button variant="secondary" onClick={() => setEditing(draftOf(school))}>Edit school</Button>
        )}
      </div>
      {editing !== undefined && (
        <form
          aria-label={`Edit ${school.name}`}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("edit", async (client) => {
              const saved = await client.call("admin.updateSchool", { params: { schoolId: school.id }, body: { name: editing.name.trim(), gradeBands: bandsOf(editing) } });
              setEditing(undefined);
              return `Saved ${saved.name}.`;
            });
          }}
        >
          <SchoolFields draft={editing} onChange={setEditing} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={action.running("edit")} disabled={!isComplete(editing)}>Save school</Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(undefined)}>Cancel</Button>
          </div>
        </form>
      )}
      <ActionOutcome outcome={action.outcome} title={school.name} />
    </div>
  );
};

const MemberTable = ({ caption, members: shown, empty }: { caption: string; members: Member[]; empty: string }) =>
  shown.length === 0 ? <Text variant="secondary">{empty}</Text> : (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <Table.Header><Table.Row><Table.Head>Name</Table.Head><Table.Head>Classes</Table.Head></Table.Row></Table.Header>
      <Table.Body>
        {shown.map((m) => (
          <Table.Row key={m.name}><Table.Cell>{m.name}</Table.Cell><Table.Cell>{m.classes.join(", ")}</Table.Cell></Table.Row>
        ))}
      </Table.Body>
    </Table>
  );

/**
 * One school (SCHO-218): its terms, its current classes with their teachers and student counts, and
 * the staff and students actively in them. Classes and people are changed under Manage classes and
 * people; the school's own name and grades can be corrected here.
 */
export const SchoolPage = ({ schoolId }: { schoolId: string }) => {
  const loaded = useLoad(`school:${schoolId}`, (client) => loadSchool(client, schoolId));
  return (
    <div className="flex flex-col gap-8">
      <Breadcrumbs>
        <Breadcrumbs.Link href="#/classes-people">Manage classes and people</Breadcrumbs.Link>
        <Breadcrumbs.Current>School</Breadcrumbs.Current>
      </Breadcrumbs>
      <LoadState loaded={loaded} what="this school" onRetry={loaded.reload}>
        {(view) => view === undefined ? (
          <Empty icon={<Buildings size={32} aria-hidden />} title="There's no such school" description="It may have been renamed or removed. Find it under Manage classes and people." />
        ) : (
          <>
            <SchoolHeading view={view} onChanged={loaded.reload} />
            <section aria-labelledby="school-terms" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="school-terms">Terms</Text>
              {view.terms.length === 0 ? <Text variant="secondary">No term has a class here yet.</Text> : (
                <Table>
                  <caption className="sr-only">Terms with classes at this school</caption>
                  <Table.Header><Table.Row><Table.Head>Term</Table.Head><Table.Head>Dates</Table.Head><Table.Head>State</Table.Head></Table.Row></Table.Header>
                  <Table.Body>
                    {view.terms.map((t) => (
                      <Table.Row key={t.id}>
                        <Table.Cell>{t.name}</Table.Cell>
                        <Table.Cell>{`${formatDate(t.startsOn)} to ${formatDate(t.endsOn)}`}</Table.Cell>
                        <Table.Cell><Badge variant={t.state === "active" ? "success" : "neutral"}>{STATE_LABEL[t.state]}</Badge></Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              )}
            </section>
            <section aria-labelledby="school-classes" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="school-classes">Classes</Text>
              <Text variant="secondary" size="sm">{count(view.classes.length, "class", "classes")}</Text>
              {view.classes.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <caption className="sr-only">This school's classes</caption>
                    <Table.Header><Table.Row><Table.Head>Class</Table.Head><Table.Head>Term</Table.Head><Table.Head>Teachers</Table.Head><Table.Head>Students</Table.Head></Table.Row></Table.Header>
                    <Table.Body>
                      {view.classes.map(({ row, term }) => (
                        <Table.Row key={row.offering.id}>
                          <Table.Cell>{title(row)}</Table.Cell>
                          <Table.Cell>{term?.name ?? ""}</Table.Cell>
                          <Table.Cell>{row.teachers.length === 0 ? <Text variant="secondary" as="span">No teacher yet</Text> : row.teachers.join(", ")}</Table.Cell>
                          <Table.Cell>{row.students}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </div>
              )}
            </section>
            <section aria-labelledby="school-staff" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="school-staff">Staff</Text>
              <MemberTable caption="Staff teaching at this school" members={view.staff} empty="No one teaches a class here yet." />
            </section>
            <section aria-labelledby="school-students" className="flex flex-col gap-3">
              <Text as="h3" variant="heading" id="school-students">Students</Text>
              <MemberTable caption="Students enrolled at this school" members={view.students} empty="No student is enrolled in a class here yet." />
            </section>
          </>
        )}
      </LoadState>
    </div>
  );
};
