import { useEffect, useRef, useState } from "react";
import { Banner, Button, Checkbox, Loader, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { ConfigRevisionId, ConfigurationRevision } from "@educateos/contracts";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";
import type { DiffEntry } from "../app/useDistrictConfig.ts";
import type { ConfigDocument } from "../configDocument.ts";
import { PlanSummary } from "./PlanSummary.tsx";

/** A configuration change to preview and then apply. */
export interface ProposedChange {
  /** The heading of the review, such as "Preview: turn on for 3 classes". */
  title: string;
  /** The document to plan and apply. */
  document: ConfigDocument;
  /** The apply button's label, such as "Activate" or "Roll back". */
  applyLabel: string;
  /** Whether applying takes something away, which styles the button as destructive. */
  removesAccess?: boolean;
}

interface ChangeReviewProps {
  /** The change. */
  change: ProposedChange;
  /** The revision the change is planned against; the district refuses the apply if another revision landed since. */
  expectedHeadRevisionId: ConfigRevisionId | undefined;
  /** Called with the new revision and what it changed. */
  onApplied: (revision: ConfigurationRevision, changes: DiffEntry[]) => void;
  /** Called when the administrator goes back without applying. */
  onCancel: () => void;
}

/**
 * The preview step every configuration change goes through: the district plans the change as a dry
 * run, the administrator reads what it does and acknowledges any approvals it needs, and only then
 * applies it as a new revision.
 */
export const ChangeReview = ({ change, expectedHeadRevisionId, onApplied, onCancel }: ChangeReviewProps) => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const heading = useRef<HTMLHeadingElement>(null);
  const planned = useLoad(`plan:${JSON.stringify(change.document)}`, (c) => c.call("admin.planConfig", { body: { document: change.document } }));
  const [acknowledged, setAcknowledged] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();

  // Focus moves to the review when it opens, so keyboard and screen-reader users land on it.
  useEffect(() => { heading.current?.focus(); }, []);

  const plan = planned.status === "ready" && planned.data.ok ? planned.data.plan : undefined;
  const needsApproval = (plan?.approvals.length ?? 0) > 0;
  const blocked = plan === undefined || plan.problems.length > 0 || plan.policyViolations.length > 0 || plan.diff.length === 0;

  const apply = async () => {
    if (plan === undefined) return;
    setApplying(true);
    setApplyError(undefined);
    try {
      const revision = await client.call("admin.applyConfig", {
        body: {
          document: change.document,
          ...(expectedHeadRevisionId === undefined ? {} : { expectedHeadRevisionId }),
          acknowledgeApprovals: acknowledged,
        },
      });
      announce(`${change.applyLabel}: done. A new configuration version is in force.`);
      onApplied(revision, plan.diff);
    } catch (error) {
      setApplyError(errorMessage(error));
      announce(`${change.applyLabel} failed.`);
      setApplying(false);
    }
  };

  return (
    <section aria-labelledby="change-review-title" className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
      <Text as="h3" variant="heading" size="lg">
        <span id="change-review-title" ref={heading} tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          {change.title}
        </span>
      </Text>
      <Text variant="secondary">This is a preview. Nothing changes until you choose {change.applyLabel}.</Text>

      {planned.status === "loading" && <div className="flex items-center gap-2"><Loader size="sm" /><Text>Preparing the preview...</Text></div>}
      {planned.status === "error" && <Banner variant="error" icon={<Warning weight="fill" />} title="The preview could not be prepared" description={planned.message} />}
      {planned.status === "ready" && !planned.data.ok && (
        <Banner
          variant="error"
          icon={<Warning weight="fill" />}
          title="This configuration is not valid"
          description={<ul className="list-disc pl-5">{planned.data.problems.map((p) => <li key={`${p.code}:${p.path}`}>{p.message}</li>)}</ul>}
        />
      )}
      {plan !== undefined && <PlanSummary plan={plan} />}

      {plan !== undefined && needsApproval && !blocked && (
        <Checkbox
          label="I am a district administrator and I approve the items listed above."
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
        />
      )}
      {applyError !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title={`${change.applyLabel} failed`} description={applyError} />}

      <div className="flex flex-wrap gap-2">
        <Button
          variant={change.removesAccess ? "destructive" : "primary"}
          disabled={blocked || (needsApproval && !acknowledged)}
          loading={applying}
          onClick={() => void apply()}
        >
          {change.applyLabel}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={applying}>Back without changing anything</Button>
      </div>
    </section>
  );
};
