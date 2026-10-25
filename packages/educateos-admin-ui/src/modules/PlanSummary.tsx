import { Badge, Banner, Table, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { PolicySettings } from "@educateos/contracts";
import type { ConfigurationPlan, DiffEntry } from "../app/useDistrictConfig.ts";
import { className, count, packName, schoolName } from "../app/labels.ts";
import { ENUMERATED_POLICIES, MONTHLY_CAP, formatCents } from "../policies/policySettings.ts";

type PackChange = ConfigurationPlan["packs"][number];
type OfferingImpact = ConfigurationPlan["offerings"][number];

const SOURCE_LABELS: Record<OfferingImpact["policy"]["sources"][keyof PolicySettings], string> = {
  profile: "District profile default",
  district: "District setting",
  school: "School setting",
  offering: "Class setting",
};

const APPROVAL_LABELS: Record<ConfigurationPlan["approvals"][number]["reason"], string> = {
  "policy-loosened": "A policy becomes less strict",
  "ai-capability-enabled": "An AI module turns on",
  "governed-setting-enabled": "A setting that widens AI use or student-data exposure turns on",
  "admin-activation-removed": "Classes will no longer wait for an administrator to activate modules",
  "exposure-activation": "Modules become visible to classes",
};

function packChangeText(change: PackChange): string {
  const parts: string[] = [];
  if (change.changes.includes("enabled") || change.changes.includes("installed") && change.after?.state !== "installed") parts.push("turns on");
  if (change.changes.includes("disabled") || change.changes.includes("uninstalled")) parts.push("turns off");
  if (change.changes.includes("mode-changed")) parts.push(`switches to ${change.after?.mode ?? "a new mode"}`);
  if (change.changes.includes("version-changed")) parts.push(`moves to version ${change.after?.version ?? ""}`);
  if (change.changes.includes("config-changed")) parts.push("settings change");
  if (change.exposedTo.length > 0) parts.push(`becomes visible to ${count(change.exposedTo.length, "class", "classes")}`);
  if (change.withdrawnFrom.length > 0) parts.push(`is removed from ${count(change.withdrawnFrom.length, "class", "classes")}`);
  return parts.length === 0 ? "changes" : parts.join(", ");
}

function settingLabel(key: keyof PolicySettings): string {
  return key === "aiMonthlyCapCentsPerPrincipal" ? MONTHLY_CAP.label : ENUMERATED_POLICIES.find((p) => p.key === key)?.label ?? key;
}

function settingValue(key: keyof PolicySettings, value: unknown): string {
  if (key === "aiMonthlyCapCentsPerPrincipal") return typeof value === "number" ? formatCents(value) : String(value);
  return ENUMERATED_POLICIES.find((p) => p.key === key)?.choices.find((c) => c.value === value)?.label ?? String(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** A diff entry's path as a breadcrumb: `/modules/content-studio/state` reads "modules › content-studio › state". */
function diffPath(path: string): string {
  return path.split("/").filter(Boolean).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~")).join(" › ") || "everything";
}

/** The detailed, field-by-field differences between two configurations. */
export const DiffList = ({ diff }: { diff: readonly DiffEntry[] }) => diff.length === 0
  ? <Text variant="secondary">No differences.</Text>
  : (
    <ul className="flex flex-col gap-1">
      {diff.map((entry) => (
        <li key={entry.path} className="flex flex-wrap items-baseline gap-2">
          <Badge variant={entry.change === "removed" ? "error" : entry.change === "added" ? "success" : "secondary"}>{entry.change}</Badge>
          <Text as="span" variant="mono">{diffPath(entry.path)}</Text>
          <Text as="span" variant="secondary">
            {entry.change === "added" ? describeValue(entry.after)
              : entry.change === "removed" ? describeValue(entry.before)
              : `${describeValue(entry.before)} → ${describeValue(entry.after)}`}
          </Text>
        </li>
      ))}
    </ul>
  );

/** The effective policy at one class, with where each value comes from. */
const EffectivePolicy = ({ impact }: { impact: OfferingImpact }) => (
  <Table>
    <Table.Header>
      <Table.Row>
        <Table.Head>Setting</Table.Head>
        <Table.Head>Value</Table.Head>
        <Table.Head>Comes from</Table.Head>
      </Table.Row>
    </Table.Header>
    <Table.Body>
      {(Object.keys(impact.policy.effective) as (keyof PolicySettings)[]).map((key) => (
        <Table.Row key={key}>
          <Table.Cell>{settingLabel(key)}</Table.Cell>
          <Table.Cell>{settingValue(key, impact.policy.effective[key])}</Table.Cell>
          <Table.Cell>{SOURCE_LABELS[impact.policy.sources[key]]}</Table.Cell>
        </Table.Row>
      ))}
    </Table.Body>
  </Table>
);

/**
 * Everything a configuration change would do, from the district's dry run: what turns on and off,
 * what turns on only because something needs it, the people reached in each class, the policy in
 * force there, and what blocks the change or needs approval. Shows counts, never names.
 */
export const PlanSummary = ({ plan }: { plan: ConfigurationPlan }) => {
  const nothingChanges = plan.diff.length === 0;
  return (
    <div className="flex flex-col gap-6">
      {plan.problems.length > 0 && (
        <Banner
          variant="error"
          icon={<Warning weight="fill" />}
          title="This change cannot be applied"
          description={<ul className="list-disc pl-5">{plan.problems.map((p) => <li key={`${p.code}:${p.path}`}>{p.message}</li>)}</ul>}
        />
      )}
      {nothingChanges && <Text>Nothing changes: this is the configuration already in force.</Text>}

      {plan.packs.length > 0 && (
        <section aria-labelledby="plan-modules" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="plan-modules">What changes</Text>
          <ul className="list-disc pl-5">
            {plan.packs.map((change) => <li key={change.capabilityId}>{packName(change.capabilityId)} {packChangeText(change)}.</li>)}
          </ul>
        </section>
      )}

      {plan.dependencyEffects.length > 0 && (
        <section aria-labelledby="plan-dependencies" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="plan-dependencies">Turned on because another module needs it</Text>
          <ul className="list-disc pl-5">
            {plan.dependencyEffects.map((effect) => (
              <li key={effect.capabilityId}>
                {packName(effect.capabilityId)} turns on, needed by {effect.pulledInBy.map(packName).join(", ")}.
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.offerings.length > 0 && (
        <section aria-labelledby="plan-classes" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="plan-classes">Classes affected</Text>
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">People reached in each affected class</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Class</Table.Head>
                  <Table.Head>School</Table.Head>
                  <Table.Head>Students</Table.Head>
                  <Table.Head>Staff</Table.Head>
                  <Table.Head>Change</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {plan.offerings.map((impact) => (
                  <Table.Row key={impact.offeringId}>
                    <Table.Cell>{className(impact.offeringId)}</Table.Cell>
                    <Table.Cell>{schoolName(impact.schoolId)}</Table.Cell>
                    <Table.Cell>{impact.students}</Table.Cell>
                    <Table.Cell>{impact.staff}</Table.Cell>
                    <Table.Cell>
                      {[
                        impact.packsExposed.length > 0 ? `Gains ${impact.packsExposed.map(packName).join(", ")}` : "",
                        impact.packsWithdrawn.length > 0 ? `Loses ${impact.packsWithdrawn.map(packName).join(", ")}` : "",
                        impact.policyChanged ? "Policy changes" : "",
                      ].filter(Boolean).join("; ")}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
          <Text variant="secondary">
            {count(plan.offerings.reduce((n, o) => n + o.students, 0), "student")} and {count(plan.offerings.reduce((n, o) => n + o.staff, 0), "staff member")} in total.
          </Text>
          {plan.offerings.map((impact) => (
            <details key={impact.offeringId} className="rounded-md border border-kumo-line p-3">
              <summary className="cursor-pointer">Policy in force at {className(impact.offeringId)}</summary>
              <div className="mt-2 overflow-x-auto"><EffectivePolicy impact={impact} /></div>
            </details>
          ))}
        </section>
      )}

      {plan.policyViolations.length > 0 && (
        <section aria-labelledby="plan-violations" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="plan-violations">Settings refused because they would loosen the district floor</Text>
          <ul className="list-disc pl-5">
            {plan.policyViolations.map((v) => (
              <li key={`${v.offeringId}:${v.level}:${v.key}`}>
                {settingLabel(v.key)} at {className(v.offeringId)} ({v.level} level): {settingValue(v.key, v.requested)} is looser than the district's {settingValue(v.key, v.floor)}.
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan.approvals.length > 0 && (
        <section aria-labelledby="plan-approvals" className="flex flex-col gap-2">
          <Text as="h4" variant="heading" id="plan-approvals">Needs a district administrator's approval</Text>
          <ul className="list-disc pl-5">
            {plan.approvals.map((a) => <li key={`${a.reason}:${a.path}`}>{APPROVAL_LABELS[a.reason]}: {a.detail}</li>)}
          </ul>
        </section>
      )}

      {!nothingChanges && (
        <details className="rounded-md border border-kumo-line p-3">
          <summary className="cursor-pointer">Every setting that changes ({plan.diff.length})</summary>
          <div className="mt-2"><DiffList diff={plan.diff} /></div>
        </details>
      )}
    </div>
  );
};
