import { useState } from "react";
import { Banner, Button, Radio, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import { isLocal, sectionLabel, type AuthoringDirectory, type Offering } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Role = "student" | "teacher" | "co-teacher";
const ROLE_LABEL: Record<Role, string> = { student: "Student", teacher: "Teacher", "co-teacher": "Co-teacher" };

/**
 * Who is in one section, and the form that adds someone. Removing a student ends their access to
 * the class; their work and records are kept.
 */
export const SectionRoster = ({ directory, offering }: { directory: AuthoringDirectory; offering: Offering }) => {
  const roster = useLoad(`roster:${offering.id}`, (client) => client.call("admin.offeringRoster", { params: { offeringId: offering.id } }));
  const action = useAuthoringAction(roster.reload);
  const [choice, setChoice] = useState<{ principalId: string; role: Role }>({ principalId: "", role: "student" });
  const label = sectionLabel(directory, offering);
  const writable = isLocal(directory, "enrollment") && offering.archivedAt === undefined;
  const chosen = directory.principals.find((p) => p.id === choice.principalId);

  return (
    <LoadState loaded={roster} what={`the people in ${label}`} onRetry={roster.reload}>
      {(entries) => {
        const enrolled = new Set(entries.map((entry) => entry.enrollment.principalId));
        const candidates = directory.principals.filter((p) => p.status === "active" && !enrolled.has(p.id));
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
                    return `${chosen?.displayName ?? "They"} joined ${label} as ${ROLE_LABEL[choice.role].toLowerCase()}.`;
                  });
                }}
              >
                <Radio.Group
                  legend="Person"
                  value={choice.principalId}
                  onValueChange={(v) => {
                    const person = directory.principals.find((p) => p.id === v);
                    setChoice({ principalId: String(v), role: person?.kind === "staff" ? "teacher" : "student" });
                  }}
                >
                  {candidates.map((p) => <Radio.Item key={p.id} value={p.id} label={p.displayName} description={p.kind === "staff" ? "Staff" : "Student"} />)}
                </Radio.Group>
                {chosen?.kind === "staff" && (
                  <Radio.Group legend="Role" value={choice.role} onValueChange={(v) => setChoice({ ...choice, role: v as Role })}>
                    <Radio.Item value="teacher" label="Teacher" />
                    <Radio.Item value="co-teacher" label="Co-teacher" />
                  </Radio.Group>
                )}
                <div>
                  <Button type="submit" variant="primary" loading={action.running("enroll")} disabled={choice.principalId === ""}>Add to section</Button>
                </div>
              </form>
            )}
            {action.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="People in this section" description={action.error} />}
          </div>
        );
      }}
    </LoadState>
  );
};
