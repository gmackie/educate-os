import { useState, type FormEvent } from "react";
import { Banner, Button, CodeBlock, Empty, Input, LayerCard, LinkButton, Table, Text } from "@cloudflare/kumo";
import { ArrowSquareOut, Buildings } from "@phosphor-icons/react";
import type { EnrollmentResponse, ImportReport, InstallationsResponse, Me, Workspace } from "../../shared/api.ts";
import { useAnnounce } from "../app/Announcer.tsx";
import { AdminApiError } from "../app/client.ts";
import { useClient, useLoad } from "../app/context.tsx";
import { HealthChip } from "../app/HealthChip.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { formatTime } from "../app/format.ts";
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line saying what an import did, or would do. */
export const describeImport = (report: ImportReport): string => {
  const parts = [
    plural(report.installations.created, "new installation"),
    plural(report.installations.updated, "changed installation"),
    plural(report.workspaces.created, "new workspace"),
    plural(report.operators.created, "new operator"),
  ];
  return `${report.dryRun ? "Would import" : "Imported"} ${parts.join(", ")}.`;
};

const SKIP_REASON = { "slug-taken": "another workspace has its slug", "origin-taken": "another workspace has its address" } as const;

/**
 * Hosted edition: the installations made through educateos.io's guided install, and the import that
 * brings new ones in. Checking runs a dry run; nothing is written until the operator imports.
 */
const Installations = ({ me, onImported }: { me: Me; onImported: () => void }) => {
  const client = useClient();
  const announce = useAnnounce();
  const [generation, setGeneration] = useState(0);
  const installations = useLoad(`installations:${generation}`, (c) => c.get<InstallationsResponse>("/api/installations"));
  const [report, setReport] = useState<ImportReport>();
  const [error, setError] = useState<string>();
  const run = async (dryRun: boolean) => {
    setError(undefined);
    try {
      const result = await client.post<ImportReport>("/api/import/control-plane", { dryRun });
      setReport(result);
      announce(describeImport(result));
      if (!dryRun) {
        setGeneration((g) => g + 1);
        onImported();
      }
    } catch (failure) {
      setError(failure instanceof AdminApiError ? failure.message : "The import didn't work.");
    }
  };
  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <Text as="h3" variant="heading">Installed through educateos.io</Text>
      <LoadState loaded={installations} what="the installations" onRetry={installations.reload}>
        {({ installations: list }) => list.length === 0 ? (
          <Text variant="secondary">None imported yet.</Text>
        ) : (
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>Address</Table.Head>
                <Table.Head>Release</Table.Head>
                <Table.Head>Installed</Table.Head>
                <Table.Head>By</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((i) => (
                <Table.Row key={i.instanceId}>
                  <Table.Cell>{i.workspaceId === undefined ? i.hostname : <a className="underline" href={workspaceHref(i.workspaceId)}>{i.hostname}</a>}</Table.Cell>
                  <Table.Cell>{i.releaseVersion}</Table.Cell>
                  <Table.Cell>{formatTime(i.installedAt)}</Table.Cell>
                  <Table.Cell>{i.installedBy ?? "—"}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </LoadState>
      {me.operator.role === "admin" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void run(true)}>Check educateos.io for new installations</Button>
          {report?.dryRun === true && <Button variant="primary" onClick={() => void run(false)}>Import</Button>}
        </div>
      )}
      {report !== undefined && (
        <Banner
          variant="default"
          title={describeImport(report)}
          description={report.skipped.length === 0 ? undefined : `Not mapped onto a workspace: ${report.skipped.map((s) => `${s.slug} (${SKIP_REASON[s.reason]})`).join(", ")}.`}
        />
      )}
      {error !== undefined && <Banner variant="error" title="Could not import" description={error} />}
    </LayerCard>
  );
};

/** Every enrolled workspace, its health and version, and enrollment. */
export const WorkspacesPage = ({ me }: { me: Me }) => {
  const workspaces = useLoad("workspaces", (client) => client.get<Workspace[]>("/api/workspaces"));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text as="h2" variant="heading" size="lg">Workspaces</Text>
        {me.installUrl !== undefined && (
          // The guided install stays on educateos.io, beside its release bucket and slug reservations.
          <LinkButton href={me.installUrl} external icon={ArrowSquareOut}>Install a new workspace</LinkButton>
        )}
      </div>
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
      {me.edition === "hosted" && <Installations me={me} onImported={workspaces.reload} />}
      {me.operator.role === "admin" && <EnrollForm me={me} onEnrolled={workspaces.reload} />}
    </div>
  );
};
