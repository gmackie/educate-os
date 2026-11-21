import { useState } from "react";
import { Badge, Banner, Button, Input, LayerCard, Table, Text } from "@cloudflare/kumo";
import { Check, Copy, Key, PlugsConnected, ShieldCheck, Warning } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { TableScroll } from "../app/TableScroll.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";

type Overview = RouteResponse<"admin.mcpOverview">;
type CreatedToken = RouteResponse<"teacher.createMcpToken">;

type ClientTab = "claude" | "chatgpt" | "claude-code" | "cursor" | "vscode" | "bearer";

const CLIENT_TABS: readonly { id: ClientTab; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "bearer", label: "Bearer token / CLI" },
];

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const scopeSummary = (scope: Overview["delegations"][number]["ceiling"]["scope"]): string => {
  if (scope.level === "district") return "Whole district";
  if (scope.level === "school") return `School ${scope.schoolId}`;
  return `Class ${scope.offeringId}`;
};

const clientInstructions = (tab: ClientTab, endpoint: string): { steps: string[]; snippet?: string } => {
  switch (tab) {
    case "claude":
      return {
        steps: [
          "Open Claude (claude.ai or Claude Desktop) -> Settings -> Connectors -> Add custom connector.",
          `Paste the Remote MCP server URL: ${endpoint}`,
          "Leave Advanced settings empty (Dynamic Client Registration is built in) and click Connect.",
          "Sign in with your school's Cloudflare Access login and choose your class scope and duration.",
        ],
      };
    case "chatgpt":
      return {
        steps: [
          "Open ChatGPT -> Settings -> Apps & Connectors -> Advanced settings -> enable Developer mode.",
          `Create a connector with MCP server URL: ${endpoint} and Authentication: OAuth.`,
          "Sign in through Cloudflare Access when prompted and approve the scope.",
        ],
      };
    case "claude-code":
      return {
        steps: [
          "Add the school's MCP server from your terminal, then run /mcp in Claude Code to sign in.",
        ],
        snippet: `claude mcp add --transport http educateos ${endpoint}`,
      };
    case "cursor":
      return {
        steps: [
          "Add this block to ~/.cursor/mcp.json (or .cursor/mcp.json in a project), then click Login in Settings -> MCP.",
        ],
        snippet: JSON.stringify({ mcpServers: { educateos: { url: endpoint } } }, null, 2),
      };
    case "vscode":
      return {
        steps: [
          "Add this block to .vscode/mcp.json and start the server from the inline code lens to sign in.",
        ],
        snippet: JSON.stringify({ servers: { educateos: { type: "http", url: endpoint } } }, null, 2),
      };
    case "bearer":
      return {
        steps: [
          "Mint a scoped personal token below for headless CLI tools, automations, or MCP clients without OAuth.",
          "Send it as an Authorization: Bearer header to the school's MCP endpoint.",
        ],
        snippet: JSON.stringify({
          mcpServers: {
            educateos: {
              url: endpoint,
              headers: { Authorization: "Bearer edum_<paste-your-token>" },
            },
          },
        }, null, 2),
      };
  }
};

/**
 * District MCP Management UI: endpoint status, quick-connect client instructions, human approval
 * queue for queued MCP writes, scoped personal bearer tokens, connected OAuth clients/delegations,
 * and the full LMS-lite tool catalog.
 */
export const McpPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const overview = useLoad("admin-mcp", (c) => c.call("admin.mcpOverview"));
  const [activeTab, setActiveTab] = useState<ClientTab>("claude");
  const [domainFilter, setDomainFilter] = useState("all");
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenScopeIdx, setTokenScopeIdx] = useState(0);
  const [tokenAccess, setTokenAccess] = useState<"read-only" | "read-drafts" | "read-write">("read-write");
  const [tokenHours, setTokenHours] = useState(720);
  const [minted, setMinted] = useState<CreatedToken>();
  const [declineReasons, setDeclineReasons] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      announce(`Copied ${label} to clipboard.`);
    } catch {
      announce(`Copy failed; select ${label} manually.`);
    }
  };

  const mintToken = async (data: Overview) => {
    const scopeOption = data.scopes[tokenScopeIdx] ?? data.scopes[0];
    if (scopeOption === undefined || tokenLabel.trim() === "") return;
    setBusyId("mint-token");
    setError(undefined);
    try {
      const created = await client.call("teacher.createMcpToken", {
        body: {
          label: tokenLabel.trim(),
          scope: scopeOption.scope,
          access: tokenAccess,
          durationHours: tokenHours,
        },
      });
      setMinted(created);
      setTokenLabel("");
      announce(`Created personal MCP token ${created.record.label}. Copy it now; it is shown only once.`);
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const revokeToken = async (tokenId: string, label: string) => {
    setBusyId(tokenId);
    setError(undefined);
    try {
      await client.call("teacher.revokeMcpToken", { params: { tokenId: tokenId as never } });
      announce(`Revoked MCP token ${label}.`);
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
      announce("Revoked MCP delegation. Its next call will be refused.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const approveAction = async (approvalId: string, digest?: string) => {
    setBusyId(approvalId);
    setError(undefined);
    try {
      await client.call("teacher.approveToolAction", {
        params: { approvalId: approvalId as never },
        body: digest === undefined ? {} : { digest },
      });
      announce("Approved and applied the queued MCP action.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  const declineAction = async (approvalId: string) => {
    const reason = (declineReasons[approvalId] ?? "").trim() || "Declined by administrator.";
    setBusyId(approvalId);
    setError(undefined);
    try {
      await client.call("teacher.declineToolAction", {
        params: { approvalId: approvalId as never },
        body: { reason },
      });
      announce("Declined the queued MCP action.");
      overview.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">MCP &amp; AI access</Text>
        <Text variant="secondary">
          Connect Claude, ChatGPT, Claude Code, Cursor, VS Code, or custom MCP clients to your school's LMS-lite tools using your Cloudflare Access sign-in.
          Every call is enforced by live class rosters, delegations, and the human approval queue below.
        </Text>
      </div>

      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Action failed" description={error} />}

      <LoadState loaded={overview} what="MCP settings" onRetry={overview.reload}>
        {(data) => {
          const endpoint = data.status.endpoint ?? `${window.location.origin}/mcp`;
          const guide = clientInstructions(activeTab, endpoint);
          const domains = ["all", ...new Set(data.tools.map((t) => t.domain))];
          const filteredTools = domainFilter === "all" ? data.tools : data.tools.filter((t) => t.domain === domainFilter);

          return (
            <>
              <LayerCard className="flex flex-col gap-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PlugsConnected size={20} aria-hidden />
                    <Text as="h3" variant="heading">District MCP server</Text>
                  </div>
                  <Badge variant={data.status.enabled ? "primary" : "neutral"}>
                    {data.status.authMode === "builtin"
                      ? "Active · Built-in Cloudflare OAuth"
                      : data.status.authMode === "external"
                        ? "Active · External OAuth"
                        : "Off in DISTRICT_CONFIG"}
                  </Badge>
                </div>

                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-sm text-kumo-subtle">MCP endpoint URL</dt>
                    <dd className="mt-0.5 flex items-center gap-2">
                      <span className="font-mono text-sm break-all">{endpoint}</span>
                      <Button size="sm" variant="secondary" icon={<Copy aria-hidden />} onClick={() => void copyText(endpoint, "MCP URL")}>
                        Copy
                      </Button>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-kumo-subtle">Exposed LMS-lite tools</dt>
                    <dd className="mt-0.5 font-semibold">{data.status.toolCount} tools across {domains.length - 1} domains</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-kumo-subtle">Write safety policy</dt>
                    <dd className="mt-0.5 text-sm">
                      {data.status.allowDrafts
                        ? "Reads & drafts run immediately; consequential writes wait for approval"
                        : "Reads run immediately; all writes wait for human confirmation"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-kumo-subtle">Pending approvals</dt>
                    <dd className="mt-0.5 font-semibold">{data.pendingApprovals.length} waiting</dd>
                  </div>
                </dl>

                {!data.status.enabled && (
                  <Banner
                    variant="alert"
                    icon={<Warning weight="fill" />}
                    title="MCP endpoint is currently off"
                    description="Run `npx launch-educate-os mcp enable` and apply your answers file to turn on built-in Cloudflare OAuth and expose /mcp."
                  />
                )}

                <div className="flex flex-col gap-3 border-t border-kumo-line pt-3">
                  <Text as="h4" variant="heading">Connect an AI client</Text>
                  <div className="flex flex-wrap gap-2" role="tablist" aria-label="MCP client guides">
                    {CLIENT_TABS.map((tab) => (
                      <Button
                        key={tab.id}
                        size="sm"
                        role="tab"
                        aria-selected={activeTab === tab.id}
                        variant={activeTab === tab.id ? "primary" : "secondary"}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        {tab.label}
                      </Button>
                    ))}
                  </div>
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    {guide.steps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                  {guide.snippet !== undefined && (
                    <div className="flex flex-col gap-2">
                      <pre className="overflow-x-auto rounded-md border border-kumo-line bg-kumo-tint p-3 font-mono text-xs">{guide.snippet}</pre>
                      <div>
                        <Button size="sm" variant="secondary" icon={<Copy aria-hidden />} onClick={() => void copyText(guide.snippet!, `${activeTab} config`)}>
                          Copy snippet
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </LayerCard>

              <section aria-labelledby="mcp-approvals" className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck size={20} aria-hidden />
                  <Text as="h3" variant="heading" id="mcp-approvals">Approval queue ({data.pendingApprovals.length})</Text>
                </div>
                <Text variant="secondary">
                  Consequential writes requested by external AI tools wait here until a person reviews the exact target and arguments and approves them.
                  MCP clients can never approve their own requests.
                </Text>
                {data.pendingApprovals.length === 0 ? (
                  <LayerCard className="p-4">
                    <Text variant="secondary">No queued MCP writes are waiting for review right now.</Text>
                  </LayerCard>
                ) : (
                  <div className="flex flex-col gap-3">
                    {data.pendingApprovals.map((item) => (
                      <LayerCard key={item.id} className="flex flex-col gap-3 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold">{item.tool}</span>
                            <Badge variant="warning">{item.needs === "approval" ? "Needs approver" : "Needs confirmation"}</Badge>
                            <Text variant="secondary" size="sm">Requested by {item.requesterName} · {when(item.createdAt)}</Text>
                          </div>
                          {item.target !== undefined && (
                            <Badge variant="neutral">{item.target.resource.kind}{item.target.resource.id ? ` · ${item.target.resource.id}` : ""}</Badge>
                          )}
                        </div>
                        <pre className="overflow-x-auto rounded-md border border-kumo-line bg-kumo-tint p-2.5 font-mono text-xs">{JSON.stringify(item.input, null, 2)}</pre>
                        <div className="flex flex-wrap items-end gap-2">
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<Check aria-hidden />}
                            disabled={busyId === item.id}
                            loading={busyId === item.id}
                            onClick={() => void approveAction(item.id, item.digest)}
                          >
                            Approve and apply
                          </Button>
                          <div className="min-w-52 flex-1">
                            <Input
                              label="Decline reason"
                              placeholder="Optional reason shown to requester"
                              value={declineReasons[item.id] ?? ""}
                              onChange={(event) => setDeclineReasons((prev) => ({ ...prev, [item.id]: event.target.value }))}
                            />
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busyId === item.id}
                            onClick={() => void declineAction(item.id)}
                          >
                            Decline
                          </Button>
                        </div>
                      </LayerCard>
                    ))}
                  </div>
                )}

                {data.recentApprovals.length > 0 && (
                  <TableScroll label="Recent tool approval decisions">
                    <Table>
                      <caption className="sr-only">Recent MCP approval decisions</caption>
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>Tool</Table.Head>
                          <Table.Head>Requester</Table.Head>
                          <Table.Head>Status</Table.Head>
                          <Table.Head>Decided</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {data.recentApprovals.slice(0, 10).map((item) => (
                          <Table.Row key={item.id}>
                            <Table.Cell><span className="font-mono text-sm">{item.tool}</span></Table.Cell>
                            <Table.Cell>{item.requesterName}</Table.Cell>
                            <Table.Cell>
                              <Badge variant={item.state === "applied" ? "primary" : "neutral"}>{item.state}</Badge>
                            </Table.Cell>
                            <Table.Cell>{item.decidedAt ? `${item.decidedByName ?? "System"} · ${when(item.decidedAt)}` : "—"}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                  </TableScroll>
                )}
              </section>

              <section aria-labelledby="mcp-tokens" className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Key size={20} aria-hidden />
                  <Text as="h3" variant="heading" id="mcp-tokens">Scoped personal bearer tokens</Text>
                </div>
                <Text variant="secondary">
                  Mint a scoped token for CLI tools, scripts, or MCP clients that use static bearer headers instead of browser OAuth.
                  Every token is bound to a real delegation, hashed before storage, and revocable in one click.
                </Text>

                {minted !== undefined && (
                  <LayerCard className="flex flex-col gap-3 p-4">
                    <Banner
                      variant="default"
                      icon={<Key weight="fill" />}
                      title={`Token "${minted.record.label}" created — copy it now`}
                      description="This secret will not be shown again."
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded border border-kumo-line bg-kumo-tint px-2.5 py-1.5 font-mono text-xs break-all">{minted.token}</code>
                      <Button size="sm" variant="primary" icon={<Copy aria-hidden />} onClick={() => void copyText(minted.token, "bearer token")}>
                        Copy token
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setMinted(undefined)}>Dismiss</Button>
                    </div>
                  </LayerCard>
                )}

                <LayerCard className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Input
                    label="Token label"
                    placeholder="e.g. Claude Code on district laptop"
                    value={tokenLabel}
                    onChange={(event) => setTokenLabel(event.target.value)}
                  />
                  <div className="flex flex-col gap-1">
                    <label htmlFor="admin-mcp-token-scope" className="text-sm font-medium">Scope</label>
                    <select
                      id="admin-mcp-token-scope"
                      className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                      value={tokenScopeIdx}
                      onChange={(event) => setTokenScopeIdx(Number(event.target.value))}
                    >
                      {data.scopes.map((option, idx) => (
                        <option key={option.label} value={idx}>{option.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="admin-mcp-token-access" className="text-sm font-medium">Permissions</label>
                    <select
                      id="admin-mcp-token-access"
                      className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                      value={tokenAccess}
                      onChange={(event) => setTokenAccess(event.target.value as "read-only" | "read-drafts" | "read-write")}
                    >
                      <option value="read-only">Read only</option>
                      <option value="read-write">Read + drafts &amp; queued writes</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label htmlFor="admin-mcp-token-duration" className="text-sm font-medium">Duration</label>
                    <select
                      id="admin-mcp-token-duration"
                      className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                      value={tokenHours}
                      onChange={(event) => setTokenHours(Number(event.target.value))}
                    >
                      <option value={24}>24 hours</option>
                      <option value={168}>7 days</option>
                      <option value={720}>30 days</option>
                      <option value={2160}>90 days</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-4">
                    <Button
                      variant="primary"
                      disabled={tokenLabel.trim() === "" || data.scopes.length === 0 || busyId === "mint-token"}
                      loading={busyId === "mint-token"}
                      onClick={() => void mintToken(data)}
                    >
                      Mint scoped token
                    </Button>
                  </div>
                </LayerCard>

                {data.tokens.length > 0 && (
                  <TableScroll label="Scoped personal MCP tokens">
                    <Table>
                      <caption className="sr-only">Scoped personal MCP bearer tokens</caption>
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>Label</Table.Head>
                          <Table.Head>Token</Table.Head>
                          <Table.Head>Owner</Table.Head>
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
                            <Table.Cell>{token.principalName}</Table.Cell>
                            <Table.Cell>{when(token.expiresAt)}</Table.Cell>
                            <Table.Cell>
                              <Badge variant={token.revoked ? "neutral" : "primary"}>
                                {token.revoked ? "Revoked" : "Active"}
                              </Badge>
                            </Table.Cell>
                            <Table.Cell>
                              {token.revoked === undefined && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busyId === token.id}
                                  onClick={() => void revokeToken(token.id, token.label)}
                                >
                                  Revoke
                                </Button>
                              )}
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                  </TableScroll>
                )}
              </section>

              <section aria-labelledby="mcp-delegations" className="flex flex-col gap-3">
                <Text as="h3" variant="heading" id="mcp-delegations">Active &amp; recent delegations ({data.delegations.length})</Text>
                <Text variant="secondary">
                  Every OAuth connection and personal token acts under one explicit delegation. Revoking a delegation stops its next MCP call immediately.
                </Text>
                {data.delegations.length === 0 ? (
                  <LayerCard className="p-4">
                    <Text variant="secondary">No delegations have been issued yet. Connect Claude, ChatGPT, or another client to create one automatically.</Text>
                  </LayerCard>
                ) : (
                  <TableScroll label="District delegations">
                    <Table>
                      <caption className="sr-only">MCP delegations</caption>
                      <Table.Header>
                        <Table.Row>
                          <Table.Head>Staff member</Table.Head>
                          <Table.Head>Client</Table.Head>
                          <Table.Head>Scope</Table.Head>
                          <Table.Head>Actions</Table.Head>
                          <Table.Head>Expires</Table.Head>
                          <Table.Head>Status</Table.Head>
                          <Table.Head>Action</Table.Head>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {data.delegations.map((delegation) => (
                          <Table.Row key={delegation.id}>
                            <Table.Cell>{delegation.grantorName}</Table.Cell>
                            <Table.Cell><span className="font-mono text-xs break-all">{delegation.client.clientId}</span></Table.Cell>
                            <Table.Cell>{scopeSummary(delegation.ceiling.scope)}</Table.Cell>
                            <Table.Cell>{delegation.ceiling.actions.filter((a) => a !== "invoke-tool").join(", ")}</Table.Cell>
                            <Table.Cell>{when(delegation.expiresAt)}</Table.Cell>
                            <Table.Cell>
                              <Badge variant={delegation.revoked ? "neutral" : "primary"}>
                                {delegation.revoked ? "Revoked" : "Active"}
                              </Badge>
                            </Table.Cell>
                            <Table.Cell>
                              {delegation.revoked === undefined && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={busyId === delegation.id}
                                  onClick={() => void revokeDelegation(delegation.id)}
                                >
                                  Revoke
                                </Button>
                              )}
                            </Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table>
                  </TableScroll>
                )}

                {data.registeredClients.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <Text as="h4" variant="heading">Dynamically registered OAuth clients ({data.registeredClients.length})</Text>
                    <TableScroll label="Registered OAuth clients">
                      <Table>
                        <caption className="sr-only">Registered OAuth clients</caption>
                        <Table.Header>
                          <Table.Row>
                            <Table.Head>Client name</Table.Head>
                            <Table.Head>Client ID</Table.Head>
                            <Table.Head>Redirect URIs</Table.Head>
                            <Table.Head>Registered</Table.Head>
                          </Table.Row>
                        </Table.Header>
                        <Table.Body>
                          {data.registeredClients.map((rc) => (
                            <Table.Row key={rc.clientId}>
                              <Table.Cell>{rc.clientName}</Table.Cell>
                              <Table.Cell><span className="font-mono text-xs">{rc.clientId}</span></Table.Cell>
                              <Table.Cell><span className="font-mono text-xs">{rc.redirectUris.join(", ")}</span></Table.Cell>
                              <Table.Cell>{when(rc.createdAt)}</Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table>
                    </TableScroll>
                  </div>
                )}
              </section>

              <section aria-labelledby="mcp-catalog" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Text as="h3" variant="heading" id="mcp-catalog">LMS-lite MCP tool catalog ({filteredTools.length})</Text>
                  <div className="flex items-center gap-2">
                    <label htmlFor="mcp-domain-filter" className="text-sm text-kumo-subtle">Domain</label>
                    <select
                      id="mcp-domain-filter"
                      className="rounded-md border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-focus"
                      value={domainFilter}
                      onChange={(event) => setDomainFilter(event.target.value)}
                    >
                      {domains.map((domain) => (
                        <option key={domain} value={domain}>{domain === "all" ? "All domains" : domain}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <TableScroll label="MCP tool catalog">
                  <Table>
                    <caption className="sr-only">LMS-lite MCP tools</caption>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Tool</Table.Head>
                        <Table.Head>Domain</Table.Head>
                        <Table.Head>Effect</Table.Head>
                        <Table.Head>Execution</Table.Head>
                        <Table.Head>Description</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {filteredTools.map((tool) => (
                        <Table.Row key={tool.name}>
                          <Table.Cell><span className="font-mono text-xs font-semibold">{tool.name}</span></Table.Cell>
                          <Table.Cell>{tool.domain}</Table.Cell>
                          <Table.Cell><Badge variant="neutral">{tool.effect}</Badge></Table.Cell>
                          <Table.Cell>
                            <Badge variant={tool.requiresApproval ? "warning" : "primary"}>
                              {tool.requiresApproval ? "Approval queue" : "Immediate"}
                            </Badge>
                          </Table.Cell>
                          <Table.Cell>{tool.description}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </TableScroll>
              </section>
            </>
          );
        }}
      </LoadState>
    </div>
  );
};
