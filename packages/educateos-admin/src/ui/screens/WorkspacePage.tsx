import { useState, type ReactNode } from "react";
import { Badge, Banner, Button, LayerCard, Meter, Table, Text } from "@cloudflare/kumo";
import type { AnalyticsRange, OpsAnalyticsResponse, OpsReleasesResponse } from "@educateos/fleet/ops";
import type { AnalyticsEnvelope, Me, WorkspaceDetail } from "../../shared/api.ts";
import { useAnnounce } from "../app/Announcer.tsx";
import { AdminApiError } from "../app/client.ts";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { useClient, useLoad } from "../app/context.tsx";
import { estimate, formatBytes, formatCount, formatPercent, formatTime, formatUsdNanos } from "../app/format.ts";
import { HealthChip } from "../app/HealthChip.tsx";
import { isOpsNotEnabled, OpsNotEnabled } from "../app/OpsNotEnabled.tsx";
import { LoadState } from "../app/LoadState.tsx";
import { WORKSPACE_TABS, workspaceHref, type WorkspaceTab } from "../app/route.ts";
import { Sparkline } from "../app/Sparkline.tsx";
import { AuditTable } from "./AuditPage.tsx";

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

const Tile = ({ title, value, note, children }: { title: string; value: string; note?: string; children?: ReactNode }) => (
  <LayerCard className="flex flex-col gap-1 p-4">
    <Text as="h3" variant="secondary">{title}</Text>
    <Text as="p" variant="heading" size="lg">{value}</Text>
    {note !== undefined && <Text as="p" variant="secondary" size="sm">{note}</Text>}
    {children}
  </LayerCard>
);

/** Says, once per panel, that figures from sampled datasets are estimates. */
const SampledNote = ({ analytics }: { analytics: AnalyticsEnvelope }) => (
  <Text variant="secondary" size="sm">
    {analytics.analytics.sampled ? "Figures marked ≈ are estimates from Cloudflare's sampled analytics. " : ""}
    {analytics.stale ? "The district can't be reached; showing" : analytics.cached ? "Cached" : "Fetched"} {formatTime(analytics.fetchedAt)}.
  </Text>
);

/** Loads one window of analytics, with the window picker and refresh. */
const WithAnalytics = ({ workspaceId, children }: { workspaceId: string; children: (analytics: AnalyticsEnvelope, range: AnalyticsRange) => ReactNode }) => {
  const [range, setRange] = useState<AnalyticsRange>("24h");
  const [refresh, setRefresh] = useState(0);
  const analytics = useLoad(`analytics:${workspaceId}:${range}:${refresh}`, (client) =>
    client.get<AnalyticsEnvelope>(`/api/workspaces/${encodeURIComponent(workspaceId)}/analytics?range=${range}${refresh > 0 ? "&refresh=1" : ""}`));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <Button key={r.value} size="sm" variant={r.value === range ? "primary" : "secondary"} aria-pressed={r.value === range} onClick={() => setRange(r.value)}>
            {r.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setRefresh((n) => n + 1)}>Refresh</Button>
      </div>
      <LoadState loaded={analytics} what="the analytics" onRetry={analytics.reload}>
        {(data) => (
          <>
            {children(data, range)}
            <SampledNote analytics={data} />
          </>
        )}
      </LoadState>
    </div>
  );
};

const errorsOf = (a: OpsAnalyticsResponse) => a.http.byStatus.filter((s) => s.status >= 500).reduce((sum, s) => sum + s.requests, 0);

const AiBudget = ({ a }: { a: OpsAnalyticsResponse }) =>
  a.ai.monthlyBudgetUsdNanos === undefined
    ? <Tile title="AI spend · month" value={formatUsdNanos(a.ai.monthToDateUsdNanos)} note="No monthly budget set." />
    : (
      <Tile title="AI spend · month" value={`${formatUsdNanos(a.ai.monthToDateUsdNanos)} of ${formatUsdNanos(a.ai.monthlyBudgetUsdNanos)}`}>
        <Meter
          label="Of the monthly budget"
          value={Math.min(a.ai.monthToDateUsdNanos, a.ai.monthlyBudgetUsdNanos)}
          max={Math.max(a.ai.monthlyBudgetUsdNanos, 1)}
          customValue={formatPercent(a.ai.monthToDateUsdNanos, a.ai.monthlyBudgetUsdNanos)}
        />
      </Tile>
    );

const Overview = ({ a, range }: { a: OpsAnalyticsResponse; range: AnalyticsRange }) => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <Tile title={`Requests · ${range}`} value={estimate(a.http.requests, a.sampled)}>
      <Sparkline label="requests" values={a.series.map((p) => p.requests)} />
    </Tile>
    <Tile title="Error rate" value={formatPercent(errorsOf(a), a.http.requests)} note={`${estimate(errorsOf(a), a.sampled)} server errors`}>
      <Sparkline label="errors" values={a.series.map((p) => p.errors)} />
    </Tile>
    <Tile title="p95 latency" value={a.http.p95LatencyMs === undefined ? "—" : `${Math.round(a.http.p95LatencyMs)} ms`} />
    <AiBudget a={a} />
  </div>
);

const Traffic = ({ a }: { a: OpsAnalyticsResponse }) => (
  <div className="flex flex-col gap-4">
    <Text as="h3" variant="heading">Workers</Text>
    <Table>
      <Table.Header>
        <Table.Row><Table.Head>Worker</Table.Head><Table.Head>Invocations</Table.Head><Table.Head>Errors</Table.Head><Table.Head>CPU p50</Table.Head><Table.Head>CPU p99</Table.Head></Table.Row>
      </Table.Header>
      <Table.Body>
        {a.workers.map((w) => (
          <Table.Row key={w.script}>
            <Table.Cell>{w.script}</Table.Cell>
            <Table.Cell>{estimate(w.invocations, a.sampled)}</Table.Cell>
            <Table.Cell>{estimate(w.errors, a.sampled)}</Table.Cell>
            <Table.Cell>{w.cpuTimeP50Ms.toFixed(1)} ms</Table.Cell>
            <Table.Cell>{w.cpuTimeP99Ms.toFixed(1)} ms</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
    <Text as="h3" variant="heading">Requests by status</Text>
    <Table>
      <Table.Header><Table.Row><Table.Head>Status</Table.Head><Table.Head>Requests</Table.Head></Table.Row></Table.Header>
      <Table.Body>
        {a.http.byStatus.map((s) => (
          <Table.Row key={s.status}><Table.Cell>{s.status}</Table.Cell><Table.Cell>{estimate(s.requests, a.sampled)}</Table.Cell></Table.Row>
        ))}
      </Table.Body>
    </Table>
  </div>
);

const Ai = ({ a }: { a: OpsAnalyticsResponse }) => (
  <div className="flex flex-col gap-4">
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile title="AI requests" value={formatCount(a.ai.requests)} note={`${formatCount(a.ai.cacheHits)} from cache`} />
      <Tile title="Tokens" value={formatCount(a.ai.tokensIn + a.ai.tokensOut)} note={`${formatCount(a.ai.tokensIn)} in, ${formatCount(a.ai.tokensOut)} out`} />
      <Tile title="Cost (guard ledger)" value={formatUsdNanos(a.ai.ledgerCostUsdNanos)} note={`AI Gateway reports ${formatUsdNanos(a.ai.gatewayCostUsdNanos)}`} />
      <AiBudget a={a} />
    </div>
    <Text variant="secondary" size="sm">The district's AI guard ledger is authoritative for budgets; AI Gateway's figure is shown to cross-check it.</Text>
  </div>
);

const Storage = ({ a }: { a: OpsAnalyticsResponse }) => (
  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <Tile title="Durable Object storage" value={formatBytes(a.durableObjects.storageBytes)} note={`${estimate(a.durableObjects.requests, a.sampled)} requests`} />
    <Tile title="R2" value={formatBytes(a.storage.r2Bytes)} />
    <Tile title="D1" value={formatBytes(a.storage.d1Bytes)} />
  </div>
);

const SIGN_IN_LABEL: Record<string, string> = { google: "Google", clever: "Clever", classlink: "ClassLink", pin: "PIN", email: "Email", other: "Other" };

const SignIns = ({ a }: { a: OpsAnalyticsResponse }) => (
  <div className="flex flex-col gap-4">
    <Table>
      <Table.Header><Table.Row><Table.Head>Method</Table.Head><Table.Head>Sign-ins</Table.Head></Table.Row></Table.Header>
      <Table.Body>
        {a.signIns.byMethod.map((m) => (
          <Table.Row key={m.method}><Table.Cell>{SIGN_IN_LABEL[m.method] ?? m.method}</Table.Cell><Table.Cell>{formatCount(m.count)}</Table.Cell></Table.Row>
        ))}
      </Table.Body>
    </Table>
    <Text>{formatCount(a.signIns.failures)} failed sign-ins.</Text>
  </div>
);

const Releases = ({ workspaceId }: { workspaceId: string }) => {
  const releases = useLoad(`releases:${workspaceId}`, (client) => client.get<OpsReleasesResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/releases`));
  return (
    <LoadState loaded={releases} what="the releases" onRetry={releases.reload}>
      {(r) => (
        <div className="flex flex-col gap-3">
          <Text>Running <strong>{r.current.version}</strong> on the {r.channel} channel.</Text>
          {r.available.length === 0 ? <Text>Up to date.</Text> : (
            <Table>
              <Table.Header><Table.Row><Table.Head>Available</Table.Head><Table.Head>Published</Table.Head><Table.Head>Notes</Table.Head></Table.Row></Table.Header>
              <Table.Body>
                {r.available.map((release) => (
                  <Table.Row key={release.version}>
                    <Table.Cell>{release.version}</Table.Cell>
                    <Table.Cell>{formatTime(release.publishedAt)}</Table.Cell>
                    <Table.Cell>{release.notesUrl === undefined ? "—" : <a className="underline" href={release.notesUrl} rel="noreferrer" target="_blank">Release notes</a>}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          <Text variant="secondary" size="sm">Updates are applied from the district's own /admin, or by the installer.</Text>
        </div>
      )}
    </LoadState>
  );
};

const Settings = ({ workspace, me, onChanged }: { workspace: WorkspaceDetail; me: Me; onChanged: () => void }) => {
  const client = useClient();
  const announce = useAnnounce();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ variant: "error" | "default"; text: string }>();
  const [notEnabled, setNotEnabled] = useState(false);
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`;
  const run = async (action: "verify" | "remove") => {
    setConfirming(false);
    setNotEnabled(false);
    try {
      await client.post(`${base}/${action}`);
      const text = action === "verify" ? "Connected: the district accepted this admin's key." : "Removed from this admin.";
      setMessage({ variant: "default", text });
      announce(text);
      onChanged();
      if (action === "remove") window.location.hash = "#/workspaces";
    } catch (error) {
      if (isOpsNotEnabled(error)) {
        setMessage(undefined);
        setNotEnabled(true);
        return;
      }
      setMessage({ variant: "error", text: error instanceof AdminApiError ? error.message : "That didn't work." });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {notEnabled && <OpsNotEnabled />}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-kumo-subtle">Origin</dt><dd>{workspace.origin}</dd>
        <dt className="text-kumo-subtle">Edition</dt><dd>{workspace.edition === "hosted" ? "Hosted by EducateOS" : "Self-hosted"}</dd>
        <dt className="text-kumo-subtle">Enrolled</dt><dd>{formatTime(workspace.enrolledAt)}</dd>
        <dt className="text-kumo-subtle">Ops key</dt><dd className="break-all">{workspace.key?.keyId ?? "None"}</dd>
      </dl>
      {message !== undefined && <Banner variant={message.variant} title={message.text} />}
      {me.operator.role === "admin" && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void run("verify")}>Verify connection</Button>
          <Button variant="destructive" onClick={() => setConfirming(true)}>Remove workspace</Button>
        </div>
      )}
      <ConfirmDialog open={confirming} title={`Remove ${workspace.displayName}?`} confirmLabel="Remove" onConfirm={() => void run("remove")} onCancel={() => setConfirming(false)}>
        <p>This admin stops managing {workspace.origin} and retires its key. Remove the key at the district too, from its /admin.</p>
      </ConfirmDialog>
    </div>
  );
};

/** One workspace: its tabs of health, Cloudflare stats, releases, settings and audit. */
export const WorkspacePage = ({ id, tab, me }: { id: string; tab: WorkspaceTab; me: Me }) => {
  const workspace = useLoad(`workspace:${id}`, (client) => client.get<WorkspaceDetail>(`/api/workspaces/${encodeURIComponent(id)}`));
  return (
    <LoadState loaded={workspace} what="the workspace" onRetry={workspace.reload}>
      {(w) => (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Text as="h2" variant="heading" size="lg">{w.displayName}</Text>
            {w.status === "active" ? <HealthChip workspaceId={w.id} showVersion /> : <Badge variant="warning">Waiting for the district</Badge>}
            <span className="text-kumo-subtle">{w.origin.replace(/^https:\/\//, "")}</span>
          </div>
          <nav aria-label={`${w.displayName} sections`}>
            <ul className="flex gap-1 overflow-x-auto border-b border-kumo-line">
              {WORKSPACE_TABS.map((t) => (
                <li key={t.path}>
                  <a
                    href={workspaceHref(w.id, t.path)}
                    aria-current={t.path === tab ? "page" : undefined}
                    className="block px-3 py-2 hover:bg-kumo-tint aria-[current=page]:border-b-2 aria-[current=page]:border-kumo-brand aria-[current=page]:font-semibold"
                  >
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <section aria-label={WORKSPACE_TABS.find((t) => t.path === tab)?.label}>
            {tab === "overview" && <WithAnalytics workspaceId={w.id}>{(a, range) => <Overview a={a.analytics} range={range} />}</WithAnalytics>}
            {tab === "traffic" && <WithAnalytics workspaceId={w.id}>{(a) => <Traffic a={a.analytics} />}</WithAnalytics>}
            {tab === "ai" && <WithAnalytics workspaceId={w.id}>{(a) => <Ai a={a.analytics} />}</WithAnalytics>}
            {tab === "storage" && <WithAnalytics workspaceId={w.id}>{(a) => <Storage a={a.analytics} />}</WithAnalytics>}
            {tab === "sign-ins" && <WithAnalytics workspaceId={w.id}>{(a) => <SignIns a={a.analytics} />}</WithAnalytics>}
            {tab === "domains" && (
              <div className="flex flex-col gap-2">
                <Text>Served from <strong>{w.origin.replace(/^https:\/\//, "")}</strong>.</Text>
                <Text variant="secondary" size="sm">Custom domains and their certificates will be managed here in a later release.</Text>
              </div>
            )}
            {tab === "releases" && <Releases workspaceId={w.id} />}
            {tab === "settings" && <Settings workspace={w} me={me} onChanged={workspace.reload} />}
            {tab === "audit" && <AuditTable workspaceId={w.id} />}
          </section>
        </div>
      )}
    </LoadState>
  );
};
