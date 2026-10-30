import { useState } from "react";
import { Button, Empty, Table, Text } from "@cloudflare/kumo";
import type { AuditEntry, AuditPage as AuditPageBody } from "../../shared/api.ts";
import { useLoad } from "../app/context.tsx";
import { formatTime } from "../app/format.ts";
import { LoadState } from "../app/LoadState.tsx";

/** The audit log, newest first, for one workspace or all of them. */
export const AuditTable = ({ workspaceId }: { workspaceId?: string }) => {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const query = new URLSearchParams({ ...(workspaceId === undefined ? {} : { workspace: workspaceId }), ...(cursor === undefined ? {} : { cursor }) });
  const page = useLoad(`audit:${query}`, (client) => client.get<AuditPageBody>(`/api/audit?${query}`));
  return (
    <LoadState loaded={page} what="the audit log" onRetry={page.reload}>
      {(data) => data.entries.length === 0 ? <Empty title="Nothing recorded yet" description="Every enrollment and every change made here is recorded." /> : (
        <div className="flex flex-col gap-2">
          <Table>
            <Table.Header>
              <Table.Row><Table.Head>When</Table.Head><Table.Head>Operator</Table.Head><Table.Head>Action</Table.Head><Table.Head>Target</Table.Head><Table.Head>Result</Table.Head></Table.Row>
            </Table.Header>
            <Table.Body>
              {data.entries.map((entry: AuditEntry) => (
                <Table.Row key={entry.id}>
                  <Table.Cell>{formatTime(entry.at)}</Table.Cell>
                  <Table.Cell>{entry.operatorEmail ?? entry.operatorSub}</Table.Cell>
                  <Table.Cell>{entry.action}</Table.Cell>
                  <Table.Cell>{entry.target ?? "—"}</Table.Cell>
                  <Table.Cell>{entry.result}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
          <div className="flex gap-2">
            {cursors.length > 0 && <Button size="sm" variant="secondary" onClick={() => setCursors(cursors.slice(0, -1))}>Newer</Button>}
            {data.nextCursor !== undefined && <Button size="sm" variant="secondary" onClick={() => setCursors([...cursors, data.nextCursor!])}>Older</Button>}
          </div>
        </div>
      )}
    </LoadState>
  );
};

/** Every action taken through this admin. */
export const AuditPage = () => (
  <div className="flex flex-col gap-4">
    <Text as="h2" variant="heading" size="lg">Audit log</Text>
    <Text variant="secondary">Who asked for what, through this admin. Each district records the same commands in its own audit log.</Text>
    <AuditTable />
  </div>
);
