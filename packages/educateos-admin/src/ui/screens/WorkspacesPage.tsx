import { useState, type FormEvent } from "react";
import { Banner, Button, CodeBlock, Empty, Input, LayerCard, Table, Text } from "@cloudflare/kumo";
import { Buildings } from "@phosphor-icons/react";
import type { EnrollmentResponse, Me, Workspace } from "../../shared/api.ts";
import { useAnnounce } from "../app/Announcer.tsx";
import { AdminApiError } from "../app/client.ts";
import { useClient, useLoad } from "../app/context.tsx";
import { HealthChip } from "../app/HealthChip.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { workspaceHref } from "../app/route.ts";

const STATUS_LABEL = { pending: "Waiting for the district", active: "Connected", removed: "Removed" } as const;

/** Enrolls a district: a new key pair, and what its administrator registers. */
const EnrollForm = ({ me, onEnrolled }: { me: Me; onEnrolled: () => void }) => {
  const client = useClient();
  const announce = useAnnounce();
  const [draft, setDraft] = useState({ slug: "", displayName: "", origin: me.allowedOrigins?.[0] ?? "" });
  const [result, setResult] = useState<EnrollmentResponse>();
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      const enrollment = await client.post<EnrollmentResponse>("/api/workspaces", draft);
      setResult(enrollment);
      announce(`Enrolled ${enrollment.workspace.displayName}. Register the key at the district next.`);
      onEnrolled();
    } catch (failure) {
      setError(failure instanceof AdminApiError ? failure.message : "Enrollment failed.");
    }
  };
  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <Text as="h3" variant="heading">Enroll a district</Text>
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Input label="Name" required value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
        <Input label="Slug" description="Lowercase, such as northfield." required value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
        <Input label="Origin" description="https://<district host>" required value={draft.origin} onChange={(e) => setDraft({ ...draft, origin: e.target.value })} />
        <Button type="submit" variant="primary">Enroll</Button>
      </form>
      {me.edition === "oss" && (
        <Text variant="secondary" size="sm">This admin manages only {me.allowedOrigins?.join(", ") || "the origins in its configuration"}.</Text>
      )}
      {error !== undefined && <Banner variant="error" title="Could not enroll" description={error} />}
      {result !== undefined && (
        <div className="flex flex-col gap-2">
          <Text as="h4" bold>Next, at {result.workspace.origin}</Text>
          <ol className="list-decimal pl-6">
            {result.instructions.map((step) => <li key={step}>{step}</li>)}
          </ol>
          <CodeBlock lang="jsonc" code={JSON.stringify(result.registration, null, 2)} />
        </div>
      )}
    </LayerCard>
  );
};

/** Every enrolled workspace, its health and version, and enrollment. */
export const WorkspacesPage = ({ me }: { me: Me }) => {
  const workspaces = useLoad("workspaces", (client) => client.get<Workspace[]>("/api/workspaces"));
  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">Workspaces</Text>
      <LoadState loaded={workspaces} what="the workspaces" onRetry={workspaces.reload}>
        {(list) => list.length === 0 ? (
          <Empty icon={<Buildings size={32} />} title="No workspaces yet" description="Enroll a district below. Its administrator then registers this admin's key." />
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Workspace</Table.Head>
                <Table.Head>Health and version</Table.Head>
                <Table.Head>Origin</Table.Head>
                <Table.Head>Status</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((w) => (
                <Table.Row key={w.id}>
                  <Table.Cell><a className="font-semibold underline" href={workspaceHref(w.id)}>{w.displayName}</a></Table.Cell>
                  <Table.Cell>{w.status === "active" ? <HealthChip workspaceId={w.id} showVersion /> : "—"}</Table.Cell>
                  <Table.Cell>{w.origin.replace(/^https:\/\//, "")}</Table.Cell>
                  <Table.Cell>{STATUS_LABEL[w.status]}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LoadState>
      {me.operator.role === "admin" && <EnrollForm me={me} onEnrolled={workspaces.reload} />}
    </div>
  );
};
