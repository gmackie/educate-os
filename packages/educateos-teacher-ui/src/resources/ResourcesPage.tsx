import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { Books, CheckCircle, Tray } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { navigate, routeHref } from "../route.ts";
import type { TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { ImportResourceForm } from "./ImportResourceForm.tsx";
import { sourceLabel } from "./pipelineState.ts";
import { rightsMode } from "./rightsModes.ts";

/** A class's resources: what is waiting for review, what is approved, and a way to add more. */
export const ResourcesPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const resources = useLoad(`resources:${offeringId}`, async (client) => {
    const [queue, releases] = await Promise.all([
      client.call("teacher.reviewQueue", { params: { offeringId } }),
      client.call("teacher.listReleases", { params: { offeringId } }),
    ]);
    return { queue, releases };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Resources · ${classLabel(teaching)}`}</PageHeading>
      <LayerCard className="p-4">
        <ImportResourceForm offeringId={offeringId} onImported={(item) => navigate({ screen: "resource", offeringId, itemId: item.id })} />
      </LayerCard>
      {resources.status === "loading" && <Loading label="Loading resources…" />}
      {resources.status === "error" && <Problem error={resources.error} onRetry={resources.reload} />}
      {resources.status === "ready" && (
        <>
          <section aria-labelledby="queue-heading" className="flex flex-col gap-3">
            <h2 id="queue-heading"><Text variant="heading" as="span">Waiting for review</Text></h2>
            {resources.data.queue.length === 0
              ? <Empty size="sm" icon={<Tray size={28} aria-hidden />} title="Nothing to review" description="Resources you add appear here until you decide on them." />
              : (
                <ul className="flex flex-col gap-2">
                  {resources.data.queue.map((entry) => (
                    <li key={entry.itemId}>
                      <LayerCard className="p-3">
                        <a href={routeHref({ screen: "resource", offeringId, itemId: entry.itemId })} className="flex flex-col gap-1 rounded text-kumo-default no-underline focus-visible:ring-2 focus-visible:ring-kumo-brand">
                          <Text bold as="span">{entry.title ?? sourceLabel(entry.source)}</Text>
                          <Text variant="secondary" size="sm" as="span">{sourceLabel(entry.source)}</Text>
                          <span className="flex flex-wrap gap-2">
                            <Badge variant="info">Ready for your review</Badge>
                            <Badge variant="neutral">{rightsMode(entry.currentRights).label}</Badge>
                            {entry.blockingFlags > 0 && <Badge variant="error">{entry.blockingFlags === 1 ? "1 serious problem" : `${entry.blockingFlags} serious problems`}</Badge>}
                          </span>
                        </a>
                      </LayerCard>
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section aria-labelledby="approved-heading" className="flex flex-col gap-3">
            <h2 id="approved-heading"><Text variant="heading" as="span">Approved for this class</Text></h2>
            {resources.data.releases.length === 0
              ? <Empty size="sm" icon={<Books size={28} aria-hidden />} title="No approved resources yet" description="Approve a resource to use it in activities." />
              : (
                <ul className="flex flex-col gap-2">
                  {resources.data.releases.map((release) => (
                    <li key={`${release.descriptor.id}@${release.descriptor.release.version}`} className="flex items-center gap-2">
                      <CheckCircle aria-hidden className="text-kumo-success" />
                      <span>{release.descriptor.title}</span>
                      <Badge variant="neutral">{rightsMode(release.descriptor.license.permittedUses.at(-1) ?? "link").label}</Badge>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}
    </div>
  );
};
