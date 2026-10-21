import type { ReactNode } from "react";
import { LayerCard, Text } from "@cloudflare/kumo";
import { count } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { useLoad } from "../app/useLoad.ts";
import type { DistrictConfigState } from "../app/useDistrictConfig.ts";
import { documentFromDesired } from "../configDocument.ts";
import { formatCents } from "../policies/policySettings.ts";

const ROSTER_PROVIDERS: Record<string, string> = {
  "oneroster-csv": "OneRoster CSV export",
  "oneroster-api": "OneRoster connection",
  manual: "Entered by hand",
};

const Tile = ({ title, value, children }: { title: string; value: string; children?: ReactNode }) => (
  <LayerCard className="flex flex-col gap-1 p-4">
    <Text as="h3" variant="secondary">{title}</Text>
    <Text as="p" variant="heading" size="lg">{value}</Text>
    {children !== undefined && <Text as="p" variant="secondary" size="sm">{children}</Text>}
  </LayerCard>
);

/**
 * The district at a glance: enrolled people, classes, issues, pending teacher work, AI spend and
 * integration health. Every figure is a count or a total. It never names a person and never shows
 * what anyone wrote.
 */
export const Dashboard = ({ state }: { state: DistrictConfigState }) => {
  const health = useLoad("health", (c) => c.call("admin.health"));
  const usage = useLoad("usage", (c) => c.call("admin.aiUsage"));
  const head = state.config.status === "ready" ? state.config.data.head : undefined;
  // Re-planning the configuration in force reports what stands in its way today, such as a class
  // whose term has closed.
  const issues = useLoad(`issues:${head?.revision.id ?? "none"}`, async (c) => {
    if (head === undefined) return 0;
    const plan = await c.call("admin.planConfig", { body: { document: documentFromDesired(head.desired) } });
    return plan.ok ? plan.plan.problems.length + plan.plan.policyViolations.length : plan.problems.length;
  });

  return (
    <div className="flex flex-col gap-6">
      <Text as="h2" variant="heading" size="lg">Dashboard</Text>
      <LoadState loaded={health} what="district health" onRetry={health.reload}>
        {(h) => (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="District at a glance">
            <li>
              <Tile title="Enrolled users" value={(h.directory.students + h.directory.staff).toLocaleString("en-US")}>
                {count(h.directory.students, "student")} and {count(h.directory.staff, "staff member")}; {count(h.directory.activeEnrollments, "active enrollment")}.
              </Tile>
            </li>
            <li>
              <Tile title="Classes" value={h.directory.offerings.toLocaleString("en-US")}>
                {head === undefined ? "SchoolOS is not set up yet."
                  : head.desired.rollout.target === "all-active-offerings" ? "Modules that are on are visible to every active class."
                  : `Modules are visible to ${count(head.desired.rollout.offerings.length, "selected class", "selected classes")}.`}
              </Tile>
            </li>
            <li>
              <LoadState loaded={issues} what="configuration issues">
                {(n) => <Tile title="Permission and configuration issues" value={n.toLocaleString("en-US")}>{n === 0 ? "Nothing is blocking the configuration in force." : "Open Modules and activation and preview a change to see them."}</Tile>}
              </LoadState>
            </li>
            <li>
              <Tile title="Pending teacher tasks" value={h.content.awaitingReview.toLocaleString("en-US")}>
                {count(h.content.awaitingReview, "imported resource")} waiting for a teacher's review.
              </Tile>
            </li>
            <li>
              <LoadState loaded={usage} what="AI usage" onRetry={usage.reload}>
                {(u) => (
                  <Tile title="AI usage and cost" value={formatCents(u.district.totalCents)}>
                    {count(u.district.requests, "request")} recorded.
                  </Tile>
                )}
              </LoadState>
            </li>
            <li>
              <Tile title="Integration health" value={head === undefined ? "Not set up" : ROSTER_PROVIDERS[head.desired.rostering.provider] ?? head.desired.rostering.provider}>
                {head?.desired.rostering.mode === "preview-before-apply" ? "Roster imports wait for an administrator's preview. " : ""}
                {count(h.work.workspaces, "learning space")}, {count(h.work.submissions, "submission")} and {count(h.config.revisions, "configuration version")} on record.
              </Tile>
            </li>
          </ul>
        )}
      </LoadState>
    </div>
  );
};
