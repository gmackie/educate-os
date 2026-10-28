import { Badge, Loader } from "@cloudflare/kumo";
import type { OpsHealthResponse } from "@educateos/fleet/ops";
import { useLoad } from "./context.tsx";

const LABEL = { ok: "Healthy", degraded: "Degraded", down: "Down" } as const;
const VARIANT = { ok: "success", degraded: "warning", down: "error" } as const;

/** A workspace's health, asked of the district live, and the version it reports. */
export const HealthChip = ({ workspaceId, showVersion = false }: { workspaceId: string; showVersion?: boolean }) => {
  const health = useLoad(`health:${workspaceId}`, (client) => client.get<OpsHealthResponse>(`/api/workspaces/${encodeURIComponent(workspaceId)}/health`));
  if (health.status === "loading") return <Loader size="sm" />;
  if (health.status === "error") return <Badge variant="secondary">Unreachable</Badge>;
  return (
    <span className="inline-flex items-center gap-2">
      <Badge variant={VARIANT[health.data.status]}>{LABEL[health.data.status]}</Badge>
      {showVersion && <span className="text-kumo-subtle">{health.data.releaseVersion}</span>}
    </span>
  );
};
