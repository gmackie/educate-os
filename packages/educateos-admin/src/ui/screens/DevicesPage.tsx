import { useState, type FormEvent } from "react";
import { Badge, Banner, Button, Empty, Input, LayerCard, Table, Text } from "@cloudflare/kumo";
import type { DeviceEntry, OpsActionResult, OpsDevicesPage } from "@educateos/fleet/ops";
import type { Me, Workspace } from "../../shared/api.ts";
import { useAnnounce } from "../app/Announcer.tsx";
import { AdminApiError } from "../app/client.ts";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { useClient, useLoad } from "../app/context.tsx";
import { formatTime } from "../app/format.ts";
import { LoadState } from "../app/LoadState.tsx";
import { isOpsNotEnabled } from "../app/OpsNotEnabled.tsx";
import { WorkspacePicker } from "../app/WorkspacePicker.tsx";

const PLATFORM = { ios: "iOS", android: "Android" } as const;

type Pending =
  | { kind: "one"; device: DeviceEntry }
  | { kind: "below"; minimumVersion: string };

const DeviceTable = ({ workspaceId, me }: { workspaceId: string; me: Me }) => {
  const client = useClient();
  const announce = useAnnounce();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/devices`;
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const page = useLoad(`devices:${workspaceId}:${cursor ?? ""}`, (c) => c.get<OpsDevicesPage>(`${base}${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`));
  const [pending, setPending] = useState<Pending>();
  const [minimum, setMinimum] = useState("");
  const [outcome, setOutcome] = useState<{ variant: "default" | "error"; text: string }>();

  const confirm = async () => {
    const action = pending;
    setPending(undefined);
    if (action === undefined) return;
    try {
      let text: string;
      if (action.kind === "one") {
        const result = await client.post<OpsActionResult>(`${base}/${encodeURIComponent(action.device.id)}/revoke`, {});
        text = result.applied ? `Revoked ${action.device.label}.` : `${action.device.label} was already revoked.`;
      } else {
        const result = await client.post<{ revoked: number }>(`${base}/revoke-below-version`, { minimumVersion: action.minimumVersion });
        text = `Revoked ${result.revoked} device${result.revoked === 1 ? "" : "s"} below ${action.minimumVersion}.`;
      }
      setOutcome({ variant: "default", text });
      announce(text);
      page.reload();
    } catch (error) {
      // A district that has since turned the ops API off is a notice, not a failure.
      setOutcome({ variant: isOpsNotEnabled(error) ? "default" : "error", text: error instanceof AdminApiError ? error.message : "That didn't work." });
    }
  };

  const forceUpdate = (event: FormEvent) => {
    event.preventDefault();
    if (/^\d+\.\d+\.\d+$/.test(minimum.trim())) setPending({ kind: "below", minimumVersion: minimum.trim() });
    else setOutcome({ variant: "error", text: "Enter a version as major.minor.patch, such as 1.4.0." });
  };

  return (
    <div className="flex flex-col gap-4">
      {outcome !== undefined && <Banner variant={outcome.variant} title={outcome.text} />}
      <LoadState loaded={page} what="the devices" onRetry={page.reload}>
        {(data) => data.devices.length === 0 ? <Empty title="No devices" description="Phones appear here once someone pairs the app." /> : (
          <>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Device</Table.Head><Table.Head>Owner</Table.Head><Table.Head>Platform</Table.Head><Table.Head>App</Table.Head>
                  <Table.Head>Registered</Table.Head><Table.Head>Last seen</Table.Head><Table.Head>Push</Table.Head><Table.Head>Status</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.devices.map((d) => (
                  <Table.Row key={d.id}>
                    <Table.Cell>{d.label}</Table.Cell>
                    <Table.Cell>{d.ownerName} <span className="text-kumo-subtle">({d.ownerRole})</span></Table.Cell>
                    <Table.Cell>{PLATFORM[d.platform]}{d.model === undefined ? "" : `, ${d.model}`}</Table.Cell>
                    <Table.Cell>{d.appVersion}</Table.Cell>
                    <Table.Cell>{formatTime(d.registeredAt)}</Table.Cell>
                    <Table.Cell>{d.lastSeenAt === undefined ? "—" : `${formatTime(d.lastSeenAt)}${d.lastCountry ? ` · ${d.lastCountry}` : ""}`}</Table.Cell>
                    <Table.Cell>{d.push ? "On" : "Off"}</Table.Cell>
                    <Table.Cell><Badge variant={d.status === "active" ? "success" : "secondary"}>{d.status === "active" ? "Active" : "Revoked"}</Badge></Table.Cell>
                    <Table.Cell>
                      {me.operator.role === "admin" && d.status === "active" && (
                        <Button size="sm" variant="secondary" aria-label={`Revoke ${d.label}`} onClick={() => setPending({ kind: "one", device: d })}>Revoke</Button>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
            <div className="flex gap-2">
              {cursors.length > 0 && <Button size="sm" variant="secondary" onClick={() => setCursors(cursors.slice(0, -1))}>Previous</Button>}
              {data.nextCursor !== undefined && <Button size="sm" variant="secondary" onClick={() => setCursors([...cursors, data.nextCursor!])}>Next</Button>}
            </div>
          </>
        )}
      </LoadState>
      {me.operator.role === "admin" && (
        <LayerCard className="flex flex-col gap-2 p-4">
          <Text as="h3" variant="heading">Force an update</Text>
          <form onSubmit={forceUpdate} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input label="Revoke every device below version" description="Such as 1.4.0. Those phones must update and pair again." value={minimum} onChange={(e) => setMinimum(e.target.value)} />
            <Button type="submit" variant="destructive">Revoke below version</Button>
          </form>
        </LayerCard>
      )}
      <ConfirmDialog
        open={pending !== undefined}
        title={pending?.kind === "one" ? `Revoke ${pending.device.label}?` : `Revoke every device below ${pending?.minimumVersion ?? ""}?`}
        confirmLabel="Revoke"
        onConfirm={() => void confirm()}
        onCancel={() => setPending(undefined)}
      >
        <p>{pending?.kind === "one" ? `${pending.device.ownerName} is signed out on this phone at their next request.` : "Every phone on an older app version is signed out and must update."}</p>
        <p>The district applies it and records it in its own audit log.</p>
      </ConfirmDialog>
    </div>
  );
};

/** Paired phones in a workspace, read live from the district. Nothing here is stored by the admin. */
export const DevicesPage = ({ me }: { me: Me }) => {
  const workspaces = useLoad("workspaces", (c) => c.get<Workspace[]>("/api/workspaces"));
  const [workspaceId, setWorkspaceId] = useState<string>();
  return (
    <div className="flex flex-col gap-4">
      <Text as="h2" variant="heading" size="lg">Devices</Text>
      <Text variant="secondary">Read live from the district each time; this admin keeps no copy.</Text>
      <LoadState loaded={workspaces} what="the workspaces" onRetry={workspaces.reload}>
        {(list) => {
          const active = list.filter((w) => w.status === "active");
          if (active.length === 0) return <Empty title="No connected workspaces" description="Enroll a district and verify its connection first." />;
          return (
            <>
              <WorkspacePicker workspaces={active} value={workspaceId} onChange={setWorkspaceId} />
              {workspaceId !== undefined && <DeviceTable key={workspaceId} workspaceId={workspaceId} me={me} />}
            </>
          );
        }}
      </LoadState>
    </div>
  );
};
