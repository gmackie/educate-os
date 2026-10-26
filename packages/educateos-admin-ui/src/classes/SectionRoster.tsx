import { useState } from "react";
import { Button, Input, Radio, Select, Table, Text } from "@cloudflare/kumo";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { count } from "../app/labels.ts";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, sectionLabel, type AuthoringDirectory, type Offering } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Role = "student" | "teacher" | "co-teacher";
type StaffRole = Exclude<Role, "student">;
const ROLE_LABEL: Record<Role, string> = { student: "Student", teacher: "Teacher", "co-teacher": "Co-teacher" };

/** How many people the picker lists at once; a search narrows the rest. */
const SHOWN = 8;

/**
 * Who is in one section, and the form that adds someone: found by name, never picked from a list of
 * the whole district, then given a role their kind allows. Removing a student ends their access to
 * the class; their work and records are kept.
 */
export const SectionRoster = ({ directory, offering }: { directory: AuthoringDirectory; offering: Offering }) => {
  const roster = useLoad(`roster:${offering.id}`, (client) => client.call("admin.offeringRoster", { params: { offeringId: offering.id } }));
  const action = useAuthoringAction(roster.reload);
  const [choice, setChoice] = useState<{ principalId: string; role: Role }>({ principalId: "", role: "student" });
  const [query, setQuery] = useState("");
  const label = sectionLabel(directory, offering);
  const writable = isLocal(directory, "enrollment") && offering.archivedAt === undefined;
  const chosen = directory.principals.find((p) => p.id === choice.principalId);

  return (
    <LoadState loaded={roster} what={`the people in ${label}`} onRetry={roster.reload}>
      {(entries) => {
        const enrolled = new Set(entries.map((entry) => entry.enrollment.principalId));
        const candidates = directory.principals.filter((p) => p.status === "active" && !enrolled.has(p.id));
        const needle = query.trim().toLowerCase();
        // A short list is shown whole; a district-sized one waits for a search.
        const matches = needle === "" ? (candidates.length <= SHOWN ? candidates : []) : candidates.filter((p) => p.displayName.toLowerCase().includes(needle));
        // The chosen person stays listed while the search changes, so the choice is never hidden.
        const shown = [...(chosen !== undefined && !matches.slice(0, SHOWN).includes(chosen) ? [chosen] : []), ...matches.slice(0, SHOWN)];
        return (
          <div className="flex flex-col gap-3">
            {entries.length === 0 ? <Text variant="secondary">Nobody is in this section yet.</Text> : (
              <Table>
                <caption className="sr-only">{`People in ${label}`}</caption>
                <Table.Header><Table.Row><Table.Head>Name</Table.Head><Table.Head>Role</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row></Table.Header>
                <Table.Body>
                  {entries.map(({ enrollment, displayName }) => (
                    <Table.Row key={enrollment.id}>
                      <Table.Cell>{displayName}</Table.Cell>
                      <Table.Cell>{ROLE_LABEL[enrollment.role]}</Table.Cell>
                      <Table.Cell>
                        {isLocal(directory, "enrollment") && (
                          <Button
                            size="sm"
                            variant="secondary-destructive"
                            aria-label={`Remove ${displayName} from ${label}`}
                            loading={action.running(enrollment.id)}
                            disabled={action.busy}
                            onClick={() => void action.run(enrollment.id, async (client) => {
                              await client.call("admin.unenroll", { params: { enrollmentId: enrollment.id } });
                              return `${displayName} is no longer in ${label}. Their work is kept.`;
                            })}
                          >
                            Remove
                          </Button>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table>
            )}
            {writable && candidates.length > 0 && (
              <form
                aria-label={`Add someone to ${label}`}
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void action.run("enroll", async (client) => {
                    await client.call("admin.enroll", { params: { offeringId: offering.id }, body: { principalId: choice.principalId, role: choice.role } });
                    setChoice({ principalId: "", role: "student" });
                    setQuery("");
                    return `${chosen?.displayName ?? "They"} joined ${label} as ${ROLE_LABEL[choice.role].toLowerCase()}.`;
                  });
                }}
              >
                <div className="max-w-sm">
                  <Input
                    label="Find a person"
                    description={`By name, among the ${count(candidates.length, "person", "people")} not in this section.`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                {needle !== "" && matches.length === 0 && <Text variant="secondary">No one matches “{query.trim()}”.</Text>}
                {shown.length > 0 && (
                  <Radio.Group
                    legend="Person"
                    value={choice.principalId}
                    onValueChange={(v) => {
                      const person = directory.principals.find((p) => p.id === v);
                      setChoice({ principalId: String(v), role: person?.kind === "staff" ? "teacher" : "student" });
                    }}
                  >
                    {shown.map((p) => <Radio.Item key={p.id} value={p.id} label={p.displayName} description={p.kind === "staff" ? "Staff" : "Student"} />)}
                  </Radio.Group>
                )}
                {matches.length > SHOWN && <Text variant="secondary" size="sm">{`Showing ${SHOWN} of ${matches.length} matches. Type more of their name to narrow it.`}</Text>}
                {chosen?.kind === "staff" && (
                  <div className="max-w-sm">
                    <Select<StaffRole>
                      label="Role"
                      value={choice.role === "student" ? "teacher" : choice.role}
                      renderValue={(value) => ROLE_LABEL[value]}
                      onValueChange={(value) => { if (value !== null) setChoice({ ...choice, role: value }); }}
                    >
                      <Select.Option value="teacher">Teacher</Select.Option>
                      <Select.Option value="co-teacher">Co-teacher</Select.Option>
                    </Select>
                  </div>
                )}
                {chosen?.kind === "student" && <Text variant="secondary">{chosen.displayName} joins as a student.</Text>}
                <div>
                  <Button type="submit" variant="primary" loading={action.running("enroll")} disabled={choice.principalId === ""}>Add to section</Button>
                </div>
              </form>
            )}
            <ActionOutcome outcome={action.outcome} title="People in this section" />
          </div>
        );
      }}
    </LoadState>
  );
};
