import { useState, type FormEvent } from "react";
import { Badge, Banner, Button, Dialog, Empty, Input, Select, Table, Text } from "@cloudflare/kumo";
import type { AiAccessLevel, DirectoryEntry, DirectoryRole, DirectoryStatus, OpsActionResult, OpsDirectoryDetail, OpsDirectoryPage } from "@educateos/fleet/ops";
import type { Me, Workspace } from "../../shared/api.ts";
import { useAnnounce } from "../app/Announcer.tsx";
import { AdminApiError } from "../app/client.ts";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { useClient, useLoad } from "../app/context.tsx";
import { formatTime, formatUsdNanos } from "../app/format.ts";
import { LoadState } from "../app/LoadState.tsx";
import { WorkspacePicker } from "../app/WorkspacePicker.tsx";

const ROLE_LABEL: Record<DirectoryRole, string> = { student: "Student", staff: "Staff", guardian: "Guardian", admin: "Admin" };
const STATUS_LABEL: Record<DirectoryStatus, string> = { "active": "Active", "suspended": "Suspended", "never-signed-in": "Never signed in" };
const AI_LABEL: Record<AiAccessLevel, string> = { none: "No AI", standard: "Standard", extended: "Extended" };

/** A command the drawer can send, with how it is confirmed. */
interface Command {
  action: "suspend" | "restore" | "sign-out-everywhere" | "roles" | "ai-access";
  body: unknown;
  title: string;
  confirmLabel: string;
  explanation: string;
  done: string;
}

/** One person: identities, roles, devices, AI, and the actions an admin may take. */
const PersonDrawer = ({ workspaceId, principal, me, onClose, onChanged }: {
  workspaceId: string;
  principal: string;
  me: Me;
  onClose: () => void;
  onChanged: () => void;
}) => {
  const client = useClient();
  const announce = useAnnounce();
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/directory/${encodeURIComponent(principal)}`;
  const detail = useLoad(`person:${workspaceId}:${principal}`, (c) => c.get<OpsDirectoryDetail>(base));
  const [pending, setPending] = useState<Command>();
  const [outcome, setOutcome] = useState<{ variant: "default" | "error"; text: string }>();

  const send = async (command: Command) => {
    setPending(undefined);
    try {
      const result = await client.post<OpsActionResult>(`${base}/${command.action}`, command.body);
      const text = result.applied ? command.done : "Nothing changed: it was already so.";
      setOutcome({ variant: "default", text });
      announce(text);
      detail.reload();
      onChanged();
    } catch (error) {
      setOutcome({ variant: "error", text: error instanceof AdminApiError ? error.message : "That didn't work." });
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog className="ml-auto h-full max-h-none w-full max-w-lg overflow-y-auto p-6" size="lg">
        <LoadState loaded={detail} what="this person" onRetry={detail.reload}>
          {({ entry, identities, deviceCount, aiUsageThisMonthUsdNanos }) => {
            const commands: Command[] = [
              entry.status === "suspended"
                ? { action: "restore", body: {}, title: `Restore ${entry.displayName}?`, confirmLabel: "Restore", explanation: "They can sign in again.", done: "Restored." }
                : { action: "suspend", body: {}, title: `Suspend ${entry.displayName}?`, confirmLabel: "Suspend", explanation: "They are signed out everywhere and can't sign in until restored. Their devices are revoked.", done: "Suspended." },
              { action: "sign-out-everywhere", body: {}, title: `Sign ${entry.displayName} out everywhere?`, confirmLabel: "Sign out everywhere", explanation: "Every session and every paired device is ended.", done: "Signed out everywhere." },
              entry.roles.includes("admin")
                ? { action: "roles", body: { grant: [], revoke: ["admin"] }, title: `Revoke admin from ${entry.displayName}?`, confirmLabel: "Revoke admin", explanation: "They lose district administration.", done: "Admin revoked." }
                : { action: "roles", body: { grant: ["admin"], revoke: [] }, title: `Make ${entry.displayName} an admin?`, confirmLabel: "Grant admin", explanation: "They can administer the district from its /admin.", done: "Admin granted." },
              entry.aiAccess === "none"
                ? { action: "ai-access", body: { level: "standard" }, title: `Turn AI on for ${entry.displayName}?`, confirmLabel: "Turn AI on", explanation: "They get the standard AI allowance.", done: "AI turned on." }
                : { action: "ai-access", body: { level: "none" }, title: `Turn AI off for ${entry.displayName}?`, confirmLabel: "Turn AI off", explanation: "They can no longer use the AI workspace.", done: "AI turned off." },
            ];
            return (
              <div className="flex flex-col gap-4">
                <Dialog.Title className="text-lg font-semibold">{entry.displayName}</Dialog.Title>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                  {entry.email !== undefined && <><dt className="text-kumo-subtle">Email</dt><dd>{entry.email}</dd></>}
                  <dt className="text-kumo-subtle">Roles</dt><dd>{entry.roles.map((r) => ROLE_LABEL[r]).join(", ") || "None"}</dd>
                  <dt className="text-kumo-subtle">Schools</dt><dd>{entry.schools.join(", ") || "None"}</dd>
                  <dt className="text-kumo-subtle">Status</dt><dd>{STATUS_LABEL[entry.status]}</dd>
                  <dt className="text-kumo-subtle">Signs in with</dt><dd>{identities.map((i) => i.method).join(", ") || "Nothing linked"}</dd>
                  <dt className="text-kumo-subtle">Last sign-in</dt><dd>{entry.lastSignInAt === undefined ? "Never" : formatTime(entry.lastSignInAt)}</dd>
                  <dt className="text-kumo-subtle">Devices</dt><dd>{deviceCount}</dd>
                  <dt className="text-kumo-subtle">AI</dt><dd>{AI_LABEL[entry.aiAccess]}, {formatUsdNanos(aiUsageThisMonthUsdNanos)} this month</dd>
                </dl>
                {entry.rostered && (
                  <Banner variant="default" title="Rostered from the student information system" description="Only status and role overrides can change here. Change anything else in the SIS." />
                )}
                {outcome !== undefined && <Banner variant={outcome.variant} title={outcome.text} />}
                {me.operator.role === "admin" && (
                  <div className="flex flex-wrap gap-2">
                    {commands.map((command) => (
                      <Button key={command.confirmLabel} variant={command.action === "suspend" ? "destructive" : "secondary"} onClick={() => setPending(command)}>
                        {command.confirmLabel}
                      </Button>
                    ))}
                  </div>
                )}
                <div><Button variant="ghost" onClick={onClose}>Close</Button></div>
                <ConfirmDialog open={pending !== undefined} title={pending?.title ?? ""} confirmLabel={pending?.confirmLabel ?? "Confirm"} onConfirm={() => { if (pending) void send(pending); }} onCancel={() => setPending(undefined)}>
                  <p>{pending?.explanation}</p>
                  <p>The district applies it and records it in its own audit log.</p>
                </ConfirmDialog>
              </div>
            );
          }}
        </LoadState>
      </Dialog>
    </Dialog.Root>
  );
};

const PeopleTable = ({ workspaceId, me }: { workspaceId: string; me: Me }) => {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<{ query?: string; role?: DirectoryRole; status?: DirectoryStatus }>({});
  const [cursors, setCursors] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const cursor = cursors.at(-1);
  const params = new URLSearchParams(Object.entries({ ...filters, cursor }).filter((e): e is [string, string] => e[1] !== undefined && e[1] !== ""));
  const page = useLoad(`people:${workspaceId}:${params}`, (c) => c.get<OpsDirectoryPage>(`/api/workspaces/${encodeURIComponent(workspaceId)}/directory?${params}`));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCursors([]);
    setFilters({ ...filters, query: search.trim() === "" ? undefined : search.trim() });
  };
  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-end" role="search">
        <Input label="Search" description="By name or email." value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select<DirectoryRole | null> label="Role" className="min-w-40" value={filters.role ?? null} renderValue={(v) => (v === null ? "Any role" : ROLE_LABEL[v])}
          onValueChange={(role) => { setCursors([]); setFilters({ ...filters, role: role ?? undefined }); }}>
          <Select.Option value={null}>Any role</Select.Option>
          {(Object.keys(ROLE_LABEL) as DirectoryRole[]).map((r) => <Select.Option key={r} value={r}>{ROLE_LABEL[r]}</Select.Option>)}
        </Select>
        <Select<DirectoryStatus | null> label="Status" className="min-w-40" value={filters.status ?? null} renderValue={(v) => (v === null ? "Any status" : STATUS_LABEL[v])}
          onValueChange={(status) => { setCursors([]); setFilters({ ...filters, status: status ?? undefined }); }}>
          <Select.Option value={null}>Any status</Select.Option>
          {(Object.keys(STATUS_LABEL) as DirectoryStatus[]).map((s) => <Select.Option key={s} value={s}>{STATUS_LABEL[s]}</Select.Option>)}
        </Select>
        <Button type="submit">Search</Button>
      </form>
      <LoadState loaded={page} what="people" onRetry={page.reload}>
        {(data) => data.entries.length === 0 ? <Empty title="Nobody matches" description="Try another search or filter." /> : (
          <>
            <Table>
              <Table.Header>
                <Table.Row><Table.Head>Name</Table.Head><Table.Head>Roles</Table.Head><Table.Head>Schools</Table.Head><Table.Head>Status</Table.Head><Table.Head>Last sign-in</Table.Head></Table.Row>
              </Table.Header>
              <Table.Body>
                {data.entries.map((p: DirectoryEntry) => (
                  <Table.Row key={p.principal}>
                    <Table.Cell><Button variant="ghost" size="sm" onClick={() => setOpen(p.principal)}>{p.displayName}</Button></Table.Cell>
                    <Table.Cell>{p.roles.map((r) => ROLE_LABEL[r]).join(", ")}</Table.Cell>
                    <Table.Cell>{p.schools.join(", ")}</Table.Cell>
                    <Table.Cell><Badge variant={p.status === "active" ? "success" : p.status === "suspended" ? "error" : "secondary"}>{STATUS_LABEL[p.status]}</Badge></Table.Cell>
                    <Table.Cell>{p.lastSignInAt === undefined ? "Never" : formatTime(p.lastSignInAt)}</Table.Cell>
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
      {open !== undefined && <PersonDrawer workspaceId={workspaceId} principal={open} me={me} onClose={() => setOpen(undefined)} onChanged={page.reload} />}
    </div>
  );
};

/** People in a workspace, read live from the district. Nothing here is stored by the admin. */
export const UsersPage = ({ me }: { me: Me }) => {
  const workspaces = useLoad("workspaces", (c) => c.get<Workspace[]>("/api/workspaces"));
  const [workspaceId, setWorkspaceId] = useState<string>();
  return (
    <div className="flex flex-col gap-4">
      <Text as="h2" variant="heading" size="lg">Users</Text>
      <Text variant="secondary">Read live from the district each time; this admin keeps no copy.</Text>
      <LoadState loaded={workspaces} what="the workspaces" onRetry={workspaces.reload}>
        {(list) => {
          const active = list.filter((w) => w.status === "active");
          if (active.length === 0) return <Empty title="No connected workspaces" description="Enroll a district and verify its connection first." />;
          return (
            <>
              <WorkspacePicker workspaces={active} value={workspaceId} onChange={setWorkspaceId} />
              {workspaceId !== undefined && <PeopleTable key={workspaceId} workspaceId={workspaceId} me={me} />}
            </>
          );
        }}
      </LoadState>
    </div>
  );
};
