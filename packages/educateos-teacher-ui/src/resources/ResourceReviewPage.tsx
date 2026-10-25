import { useState } from "react";
import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { routeHref } from "../route.ts";
import type { ResourceReport, RightsMode, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { AiFindings } from "./AiFindings.tsx";
import { reviewStatus, sourceLabel } from "./pipelineState.ts";
import { RightsChooser } from "./RightsChooser.tsx";
import { licenseSummary, rightsMode } from "./rightsModes.ts";

const SEVERITY = { blocking: "error", warning: "warning", info: "info" } as const;

/** One resource's review report, and the teacher's decision on it. */
export const ResourceReviewPage = ({ teaching, itemId }: { teaching: TeachingOffering; itemId: string }) => {
  const report = useLoad(`resource:${itemId}`, (client) => client.call("teacher.resourceReport", { params: { itemId } }));
  return (
    <div className="flex flex-col gap-6">
      <a href={routeHref({ screen: "resources", offeringId: teaching.offering.id })}>Back to resources</a>
      {report.status === "loading" && <Loading label="Loading the review report…" />}
      {report.status === "error" && <Problem error={report.error} onRetry={report.reload} />}
      {report.status === "ready" && <Report key={report.data.revision} item={report.data} onDecided={report.reload} />}
    </div>
  );
};

const Report = ({ item, onDecided }: { item: ResourceReport; onDecided: () => void }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [rights, setRights] = useState<RightsMode>(item.rights.current);
  const [approving, setApproving] = useState<{ status: "idle" | "sending" } | { status: "failed"; error: unknown }>({ status: "idle" });
  const status = reviewStatus(item.state);
  const checks = item.checks;
  const title = item.title ?? sourceLabel(item.source);

  const approve = async () => {
    setApproving({ status: "sending" });
    try {
      await client.call("teacher.approveResource", { params: { itemId: item.id }, body: {} });
      setApproving({ status: "idle" });
      announce(`${title} is approved for this class.`);
      onDecided();
    } catch (error) {
      setApproving({ status: "failed", error });
    }
  };

  return (
    <article aria-labelledby="report-title" className="flex flex-col gap-6">
      <div id="report-title"><PageHeading>{title}</PageHeading></div>
      <span className="flex flex-wrap gap-2">
        <Badge variant={status.awaitingDecision ? "info" : "neutral"}>{status.label}</Badge>
      </span>

      <section aria-labelledby="source-heading" className="flex flex-col gap-2">
        <h2 id="source-heading"><Text variant="heading" as="span">Source</Text></h2>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
          <dt className="font-medium">Where it came from</dt>
          <dd className="break-all">{sourceLabel(item.source)}</dd>
          {item.source.kind === "url" && item.source.finalUrl !== item.source.submittedUrl && (
            <>
              <dt className="font-medium">Which led to</dt>
              <dd className="break-all">{item.source.finalUrl}</dd>
            </>
          )}
          <dt className="font-medium">Credit</dt>
          <dd>{checks?.attribution ?? "The source doesn't name its author."}</dd>
          <dt className="font-medium">License</dt>
          <dd>{licenseSummary(item.license)}</dd>
        </dl>
      </section>

      <section aria-labelledby="rights-heading" className="flex flex-col gap-2">
        <h2 id="rights-heading"><Text variant="heading" as="span">Rights</Text></h2>
        <Text>{`Allowed now: ${rightsMode(item.rights.current).label}. ${rightsMode(item.rights.current).explanation}`}</Text>
        <RightsChooser granted={item.rights.current} value={rights} onChange={setRights} disabled={!status.awaitingDecision} />
        {rights !== item.rights.current && (
          <Banner
            variant="alert"
            title={`You chose ${rightsMode(rights).label}.`}
            description="Saving a narrower choice isn't turned on for your district yet, so approving keeps the mode above. Ask your curriculum admin if this class must use less."
          />
        )}
      </section>

      <section aria-labelledby="checks-heading" className="flex flex-col gap-2">
        <h2 id="checks-heading"><Text variant="heading" as="span">Checks</Text></h2>
        {checks === undefined ? <Text variant="secondary">This resource hasn't been checked yet.</Text> : (
          <>
            <ul className="flex flex-col gap-1">
              <li>{checks.accessibility.lang === undefined ? "The page doesn't say what language it's in." : `Language: ${checks.accessibility.lang}`}</li>
              <li>
                {checks.accessibility.images === 0
                  ? "No images."
                  : `${checks.accessibility.images} images, ${checks.accessibility.imagesWithoutAlt} without a text description.`}
              </li>
            </ul>
            {checks.flags.length === 0 ? <Text variant="secondary">No problems found.</Text> : (
              <ul aria-label="Problems found" className="flex flex-col gap-2">
                {checks.flags.map((flag) => (
                  <li key={flag.code} className="flex items-start gap-2">
                    <Badge variant={SEVERITY[flag.severity]} icon={<Warning aria-hidden />}>{flag.severity === "blocking" ? "Serious" : flag.severity === "warning" ? "Check" : "Note"}</Badge>
                    <span>{flag.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <AiFindings ai={item.ai} />

      <LayerCard className="flex flex-col gap-3 p-4">
        <h2><Text variant="heading" as="span">Your decision</Text></h2>
        {status.awaitingDecision ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Button variant="primary" icon={<CheckCircle aria-hidden />} loading={approving.status === "sending"} onClick={() => void approve()}>
              Approve for this class
            </Button>
            <div className="flex flex-col gap-1">
              <Button disabled aria-describedby="admin-review-help">Request admin review</Button>
              <Text variant="secondary" size="sm" as="span">
                <span id="admin-review-help">Sending a resource to your curriculum admin isn't turned on for your district yet. Leave it here and tell them directly.</span>
              </Text>
            </div>
          </div>
        ) : <Text>{item.decision?.outcome === "rejected" ? "This resource wasn't approved." : "You've decided on this resource."}</Text>}
        {approving.status === "failed" && <Problem error={approving.error} />}
      </LayerCard>
    </article>
  );
};
