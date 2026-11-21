import { useState } from "react";
import { Badge, Banner, Button, Input, LayerCard, Table, Text } from "@cloudflare/kumo";
import { Check, Copy, Key, PlugsConnected, ShieldCheck, Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { describeProblem } from "../errorMessage.ts";
import { routeHref } from "../route.ts";
import { useLoad } from "../useLoad.ts";

const errorMessage = (error: unknown): string => {
  const problem = describeProblem(error);
  return problem.detail ? `${problem.message} ${problem.detail}` : problem.message;
};

type Overview = RouteResponse<"teacher.mcpOverview">;
type CreatedToken = RouteResponse<"teacher.createMcpToken">;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Teacher Studio MCP & AI access screen: connect Claude / ChatGPT / editors to your classes,
 * review and approve or decline queued MCP writes, and mint or revoke personal scoped tokens.
 */
export const TeacherMcpPage = () => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const overview = useLoad("teacher-mcp", (c) => c.call("teacher.mcpOverview"));
  const [label, setLabel] = useState("");
  const [scopeIdx, setScopeIdx] = useState(0);
  const [access, setAccess] = useState<"read-only" | "read-write">("read-write");
  const [durationHours, setDurationHours] = useState(720);
  const [minted, setMinted] = useState<CreatedToken>();
  const [declineReasons, setDeclineReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      announce(`Copied ${what} to clipboard.`);
    } catch {
      announce(`Could not copy ${what}.`);
    }
  };

  const mint = async (data: Overview) => {
    const scopeOption = data.scopes[scopeIdx] ?? data.scopes[0];
    if (scopeOption === undefined || label.trim() === "") return;
    setBusyId("mint");
    setError(undefined);
    try {
      const created = await client.call("teacher.createMcpToken", {
        body: { label: label.trim(), scope: scopeOption.scope, access, durationHours },
      });
      setMinted(created);
      setLabel("");
      announce(`Created token ${created.record.label}. Copy it now; it is shown only once.`);
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const approve = async (approvalId: string, digest?: string) => {
    setBusyId(approvalId);
    setError(undefined);
    try {
      await client.call("teacher.approveToolAction", {
        params: { approvalId: approvalId as never },
        body: digest === undefined ? {} : { digest },
      });
      announce("Approved and applied the queued action.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const decline = async (approvalId: string) => {
    const reason = (declineReasons[approvalId] ?? "").trim() || "Declined by teacher.";
    setBusyId(approvalId);
    setError(undefined);
    try {
      await client.call("teacher.declineToolAction", {
        params: { approvalId: approvalId as never },
        body: { reason },
      });
      announce("Declined the queued action.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const revokeToken = async (tokenId: string) => {
    setBusyId(tokenId);
    setError(undefined);
    try {
      await client.call("teacher.revokeMcpToken", { params: { tokenId: tokenId as never } });
      announce("Revoked personal MCP token.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const revokeDelegation = async (delegationId: string) => {
    setBusyId(delegationId);
    setError(undefined);
    try {
      await client.call("teacher.revokeDelegation", { params: { delegationId: delegationId as never } });
      announce("Revoked AI client delegation.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageHeading>AI &amp; MCP access</PageHeading>
        <a href={routeHref({ screen: "classes" })} className="rounded text-sm focus-visible:ring-2 focus-visible:ring-kumo-brand">
          Back to my classes
        </a>
      </div>

      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Could not complete action" description={error} />}
      {overview.status === "loading" && <Loading label="Loading AI & MCP access…" />}
      {overview.status === "error" && <Problem error={overview.error} onRetry={overview.reload} />}

      {overview.status === "ready" && (() => {
        const data = overview.data;
        const endpoint = data.status.endpoint ?? `${window.location.origin}/mcp`;
        return (
          <>
            <LayerCard className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <PlugsConnected size={20} aria-hidden />
                  <Text as="h2" variant="heading">Your school's MCP server</Text>
                </div>
                <Badge variant={data.status.enabled ? "primary" : "neutral"}>
                  {data.status.enabled ? `${data.status.toolCount} LMS tools active` : "Not enabled"}
                </Badge>
              </div>
              <Text variant="secondary">
                Paste this URL into Claude, ChatGPT, Claude Code, Cursor, or VS Code to work with your classes over MCP.
                You will sign in with your normal school login and choose which class to share.
              </Text>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded border border-kumo-line bg-kumo-tint px-2.5 py-1.5 font-mono text-sm break-all">{endpoint}</code>
                <Button size="sm" variant="secondary" icon={<Copy aria-hidden />} onClick={() => void copy(endpoint, "MCP endpoint URL")}>
                  Copy URL
                </Button>
              </div>
            </LayerCard>

            <section aria-labelledby="teacher-mcp-approvals" className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={20} aria-hidden />
                <Text as="h2" variant="heading" id="teacher-mcp-approvals">Pending approvals ({data.pendingApprovals.length})</Text>
              </div>
              {data.pendingApprovals.length === 0 ? (
                <LayerCard className="p-4">
                  <Text variant="secondary">No queued AI tool actions are waiting for your confirmation.</Text>
                </LayerCard>
              ) : (
                data.pendingApprovals.map((item) => (
                  <LayerCard key={item.id} className="flex flex-col gap-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{item.tool}</span>
                      <Text variant="secondary" size="sm">{when(item.createdAt)}</Text>
                    </div>
                    <pre className="overflow-x-auto rounded border border-kumo-line bg-kumo-tint p-2.5 font-mono text-xs">{JSON.stringify(item.input, null, 2)}</pre>
                    <div className="flex flex-wrap items-end gap-2">
                      <Button variant="primary" size="sm" icon={<Check aria-hidden />} disabled={busyId === item.id} loading={busyId === item.id} onClick={() => void approve(item.id, item.digest)}>
                        Approve
                      </Button>
                      <div className="min-w-48 flex-1">
                        <Input
                          label="Reason to decline"
                          value={declineReasons[item.id] ?? ""}
                          onChange={(e) => setDeclineReasons((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        />
                      </div>
                      <Button variant="secondary" size="sm" disabled={busyId === item.id} onClick={() => void decline(item.id)}>
                        Decline
                      </Button>
                    </div>
                  </LayerCard>
                ))
              )}
            </section>

            <section aria-labelledby="teacher-mcp-tokens" className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Key size={20} aria-hidden />
                <Text as="h2" variant="heading" id="teacher-mcp-tokens">Personal bearer tokens</Text>
              </div>
              {minted !== undefined && (
                <LayerCard className="flex flex-col gap-3 p-4">
                  <Banner variant="default" icon={<Key weight="fill" />} title={`Token "${minted.record.label}" created`} description="Copy it now; it will not be shown again." />
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="rounded border border-kumo-line bg-kumo-tint px-2.5 py-1.5 font-mono text-xs break-all">{minted.token}</code>
                    <Button size="sm" variant="primary" icon={<Copy aria-hidden />} onClick={() => void copy(minted.token, "personal token")}>Copy token</Button>
                    <Button size="sm" variant="secondary" onClick={() => setMinted(undefined)}>Dismiss</Button>
                  </div>
                </LayerCard>
              )}
              <LayerCard className="grid gap-3 p-4 sm:grid-cols-2">
                <Input label="Label" placeholder="e.g. Lesson prep CLI" value={label} onChange={(e) => setLabel(e.target.value)} />
                <div className="flex flex-col gap-1">
                  <label htmlFor="teacher-mcp-scope" className="text-sm font-medium">Class or scope</label>
                  <select
                    id="teacher-mcp-scope"
                    className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                    value={scopeIdx}
                    onChange={(e) => setScopeIdx(Number(e.target.value))}
                  >
                    {data.scopes.map((s, idx) => <option key={s.label} value={idx}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="teacher-mcp-access" className="text-sm font-medium">Access</label>
                  <select
                    id="teacher-mcp-access"
                    className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                    value={access}
                    onChange={(e) => setAccess(e.target.value as "read-only" | "read-write")}
                  >
                    <option value="read-only">Read only</option>
                    <option value="read-write">Read + drafts &amp; queued writes</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="teacher-mcp-duration" className="text-sm font-medium">Expires after</label>
                  <select
                    id="teacher-mcp-duration"
                    className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                    value={durationHours}
                    onChange={(e) => setDurationHours(Number(e.target.value))}
                  >
                    <option value={24}>24 hours</option>
                    <option value={168}>7 days</option>
                    <option value={720}>30 days</option>
                    <option value={2160}>90 days</option>
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <Button variant="primary" disabled={label.trim() === "" || data.scopes.length === 0 || busyId === "mint"} loading={busyId === "mint"} onClick={() => void mint(data)}>
                    Create token
                  </Button>
                </div>
              </LayerCard>

              {data.tokens.length > 0 && (
                <Table>
                  <caption className="sr-only">Your personal MCP tokens</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Label</Table.Head>
                      <Table.Head>Prefix</Table.Head>
                      <Table.Head>Expires</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Action</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.tokens.map((token) => (
                      <Table.Row key={token.id}>
                        <Table.Cell>{token.label}</Table.Cell>
                        <Table.Cell><span className="font-mono text-xs">{token.prefix}</span></Table.Cell>
                        <Table.Cell>{when(token.expiresAt)}</Table.Cell>
                        <Table.Cell><Badge variant={token.revoked ? "neutral" : "primary"}>{token.revoked ? "Revoked" : "Active"}</Badge></Table.Cell>
                        <Table.Cell>
                          {token.revoked === undefined && (
                            <Button size="sm" variant="secondary" disabled={busyId === token.id} onClick={() => void revokeToken(token.id)}>Revoke</Button>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              )}
            </section>

            <section aria-labelledby="teacher-mcp-delegations" className="flex flex-col gap-3">
              <Text as="h2" variant="heading" id="teacher-mcp-delegations">Your connected clients ({data.delegations.length})</Text>
              {data.delegations.length === 0 ? (
                <LayerCard className="p-4">
                  <Text variant="secondary">No connected AI clients yet.</Text>
                </LayerCard>
              ) : (
                <Table>
                  <caption className="sr-only">Your AI client delegations</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Client</Table.Head>
                      <Table.Head>Expires</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Action</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.delegations.map((delegation) => (
                      <Table.Row key={delegation.id}>
                        <Table.Cell><span className="font-mono text-xs break-all">{delegation.client.clientId}</span></Table.Cell>
                        <Table.Cell>{when(delegation.expiresAt)}</Table.Cell>
                        <Table.Cell><Badge variant={delegation.revoked ? "neutral" : "primary"}>{delegation.revoked ? "Revoked" : "Active"}</Badge></Table.Cell>
                        <Table.Cell>
                          {delegation.revoked === undefined && (
                            <Button size="sm" variant="secondary" disabled={busyId === delegation.id} onClick={() => void revokeDelegation(delegation.id)}>Revoke</Button>
                          )}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              )}
            </section>
          </>
        );
      })()}
    </div>
  );
};
