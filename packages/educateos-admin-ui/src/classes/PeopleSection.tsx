import { useState } from "react";
import { Badge, Button, Input, Radio, Table, Text } from "@cloudflare/kumo";
import { ActionOutcome } from "./ActionOutcome.tsx";
import { isLocal, type AuthoringDirectory, type Person } from "./authoring.ts";
import { PersonEditor, type EditableKind } from "./PersonEditor.tsx";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Kind = EditableKind;
// No kind is chosen until the administrator picks one: a default turned an intended administrator
// into a student once (SCHO-212).
const EMPTY = { kind: undefined as Kind | undefined, displayName: "", email: "", subject: "", issuer: "" };

const STATUS_LABEL: Record<Person["status"], string> = { active: "Active", graduated: "Graduated", inactive: "Inactive" };

/**
 * The district's students and staff, what an administrator can change about each, and a form that
 * adds someone with the sign-in that will resolve to them. A sign-in is identified by the identity
 * provider's subject, never an email address, so the administrator copies it from the provider
 * (for Cloudflare Access, the user's ID). Nobody is deleted: someone who leaves is deactivated, and
 * their records are kept.
 *
 * The district refuses the changes that would lock administrators out: taking away the caller's own
 * administration or deactivating them, and leaving no active administrator. Those are not offered.
 * `selfId` is the signed-in administrator, once known.
 */
export const PeopleSection = ({ directory, selfId, onChanged }: { directory: AuthoringDirectory; selfId: string | undefined; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [person, setPerson] = useState(EMPTY);
  const [editing, setEditing] = useState<string>();
  const issuer = directory.trustedIssuers.length === 1 ? directory.trustedIssuers[0]! : person.issuer;
  const local = isLocal(directory, "principal");
  const edited = directory.principals.find((p) => p.id === editing);
  const activeAdmins = directory.principals.filter((p) => p.districtAdmin && p.status === "active");
  // Whether the district would refuse to take `p`'s administration or activity away.
  const keepsConsoleOpen = (p: Person) => p.id === selfId || (p.districtAdmin && activeAdmins.length === 1 && activeAdmins[0]!.id === p.id);
  const locked = directory.principals.filter((p) => p.status === "active" && keepsConsoleOpen(p));

  const setStatus = (p: Person, status: "active" | "inactive") => void action.run(`status:${p.id}`, async (client) => {
    await client.call("admin.setPrincipalStatus", { params: { principalId: p.id }, body: { status } });
    return status === "active" ? `${p.displayName} is active again.` : `${p.displayName} is deactivated. Their records are kept.`;
  });
  const setAdmin = (p: Person, admin: boolean) => void action.run(`admin:${p.id}`, async (client) => {
    if (admin) await client.call("admin.grantDistrictAdmin", { params: { principalId: p.id }, body: {} });
    else await client.call("admin.revokeDistrictAdmin", { params: { principalId: p.id }, body: {} });
    return admin ? `${p.displayName} is now a district administrator.` : `${p.displayName} is no longer a district administrator.`;
  });

  return (
    <section aria-labelledby="people-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="people-heading">People</Text>
      <Table>
        <caption className="sr-only">Students and staff</caption>
        <Table.Header>
          <Table.Row><Table.Head>Name</Table.Head><Table.Head>Kind</Table.Head><Table.Head>Status</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head></Table.Row>
        </Table.Header>
        <Table.Body>
          {directory.principals.map((p) => (
            <Table.Row key={p.id}>
              <Table.Cell>{p.displayName}</Table.Cell>
              <Table.Cell>
                <span className="flex flex-wrap items-center gap-2">
                  {p.kind === "staff" ? "Staff" : "Student"}
                  {p.id === selfId && <Badge variant="neutral">You</Badge>}
                  {p.districtAdmin && <Badge variant="info">Administrator</Badge>}
                </span>
              </Table.Cell>
              <Table.Cell><Badge variant={p.status === "active" ? "success" : "neutral"}>{STATUS_LABEL[p.status]}</Badge></Table.Cell>
              <Table.Cell>
                <span className="flex flex-wrap gap-2">
                  {local && (
                    <Button size="sm" variant="secondary" aria-label={`Edit ${p.displayName}`} disabled={action.busy} onClick={() => setEditing(p.id)}>Edit</Button>
                  )}
                  {p.kind === "staff" && p.status === "active" && !(p.districtAdmin && keepsConsoleOpen(p)) && (
                    <Button
                      size="sm"
                      variant={p.districtAdmin ? "secondary-destructive" : "secondary"}
                      aria-label={p.districtAdmin ? `Remove ${p.displayName} as administrator` : `Make ${p.displayName} an administrator`}
                      loading={action.running(`admin:${p.id}`)}
                      disabled={action.busy}
                      onClick={() => setAdmin(p, !p.districtAdmin)}
                    >
                      {p.districtAdmin ? "Remove administrator" : "Make administrator"}
                    </Button>
                  )}
                  {local && !(p.status === "active" && keepsConsoleOpen(p)) && (
                    <Button
                      size="sm"
                      variant={p.status === "active" ? "secondary-destructive" : "secondary"}
                      aria-label={p.status === "active" ? `Deactivate ${p.displayName}` : `Reactivate ${p.displayName}`}
                      loading={action.running(`status:${p.id}`)}
                      disabled={action.busy}
                      onClick={() => setStatus(p, p.status === "active" ? "inactive" : "active")}
                    >
                      {p.status === "active" ? "Deactivate" : "Reactivate"}
                    </Button>
                  )}
                </span>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {locked.length > 0 && (
        <Text variant="secondary" size="sm">
          {locked.some((p) => p.id === selfId) ? "You can't remove your own administration or deactivate yourself; another administrator can. " : ""}
          {activeAdmins.length === 1 ? `${activeAdmins[0]!.displayName} is the only administrator, so they stay one until you make someone else an administrator.` : ""}
        </Text>
      )}
      {edited !== undefined && (
        <PersonEditor
          key={edited.id}
          person={edited}
          saving={action.running("edit")}
          onCancel={() => setEditing(undefined)}
          onSave={(change) => void action.run("edit", async (client) => {
            await client.call("admin.updatePrincipal", { params: { principalId: edited.id }, body: change });
            setEditing(undefined);
            return `Saved ${change.displayName ?? edited.displayName}.`;
          })}
        />
      )}
      {local && (
        <form
          aria-label="Add a person"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const kind = person.kind;
            if (kind === undefined) return;
            void action.run("create", async (client) => {
              const created = await client.call("admin.createPrincipal", {
                body: {
                  kind,
                  displayName: person.displayName.trim(),
                  ...(person.email.trim() === "" ? {} : { email: person.email.trim() }),
                  identity: { issuer, subject: person.subject.trim() },
                },
              });
              setPerson(EMPTY);
              return `Added ${created.displayName}. Add them to a section next.`;
            });
          }}
        >
          <Radio.Group legend="Kind" value={person.kind ?? ""} onValueChange={(v) => setPerson({ ...person, kind: v as Kind })}>
            <Radio.Item value="student" label="Student" />
            <Radio.Item value="staff" label="Staff (teachers, helpers and administrators)" />
          </Radio.Group>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Input label="Name" required value={person.displayName} onChange={(e) => setPerson({ ...person, displayName: e.target.value })} />
            <Input label="Email (optional)" type="email" description="For display and messages only." value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} />
          </div>
          {directory.trustedIssuers.length > 1 && (
            <Radio.Group legend="Signs in through" value={person.issuer} onValueChange={(v) => setPerson({ ...person, issuer: String(v) })}>
              {directory.trustedIssuers.map((i) => <Radio.Item key={i} value={i} label={i} />)}
            </Radio.Group>
          )}
          <Input
            label="Sign-in ID"
            description="Their user ID from your sign-in provider. Inviting someone by email isn't available yet."
            required
            value={person.subject}
            onChange={(e) => setPerson({ ...person, subject: e.target.value })}
          />
          <div>
            <Button
              type="submit"
              variant="primary"
              loading={action.running("create")}
              disabled={person.kind === undefined || person.displayName.trim() === "" || person.subject.trim() === "" || issuer === ""}
            >
              Add person
            </Button>
          </div>
        </form>
      )}
      <ActionOutcome outcome={action.outcome} title="People" />
    </section>
  );
};
