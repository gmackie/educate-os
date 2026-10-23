import { useState } from "react";
import { Badge, Banner, Button, Input, Radio, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import { isLocal, type AuthoringDirectory } from "./authoring.ts";
import { useAuthoringAction } from "./useAuthoringAction.ts";

type Kind = "student" | "staff";
const EMPTY = { kind: "student" as Kind, displayName: "", email: "", subject: "", issuer: "" };

/**
 * The district's students and staff, and a form that adds someone with the sign-in that will
 * resolve to them. A sign-in is identified by the identity provider's subject, never an email
 * address, so the administrator copies it from the provider (for Cloudflare Access, the user's ID).
 */
export const PeopleSection = ({ directory, onChanged }: { directory: AuthoringDirectory; onChanged: () => void }) => {
  const action = useAuthoringAction(onChanged);
  const [person, setPerson] = useState(EMPTY);
  const issuer = directory.trustedIssuers.length === 1 ? directory.trustedIssuers[0]! : person.issuer;
  return (
    <section aria-labelledby="people-heading" className="flex flex-col gap-3">
      <Text as="h3" variant="heading" id="people-heading">People</Text>
      <Table>
        <caption className="sr-only">Students and staff</caption>
        <Table.Header><Table.Row><Table.Head>Name</Table.Head><Table.Head>Kind</Table.Head><Table.Head>Status</Table.Head></Table.Row></Table.Header>
        <Table.Body>
          {directory.principals.map((p) => (
            <Table.Row key={p.id}>
              <Table.Cell>{p.displayName}</Table.Cell>
              <Table.Cell>{p.kind === "staff" ? "Staff" : "Student"}</Table.Cell>
              <Table.Cell><Badge variant={p.status === "active" ? "success" : "neutral"}>{p.status === "active" ? "Active" : p.status === "graduated" ? "Graduated" : "Inactive"}</Badge></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
      {isLocal(directory, "principal") && (
        <form
          aria-label="Add a person"
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run("create", async (client) => {
              const created = await client.call("admin.createPrincipal", {
                body: {
                  kind: person.kind,
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
          <Radio.Group legend="Kind" value={person.kind} onValueChange={(v) => setPerson({ ...person, kind: v as Kind })}>
            <Radio.Item value="student" label="Student" />
            <Radio.Item value="staff" label="Staff (teachers and helpers)" />
          </Radio.Group>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
            <Button type="submit" variant="primary" loading={action.running("create")} disabled={person.displayName.trim() === "" || person.subject.trim() === "" || issuer === ""}>Add person</Button>
          </div>
        </form>
      )}
      {action.error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="People" description={action.error} />}
    </section>
  );
};
