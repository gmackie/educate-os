import { useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { ArtifactViewer } from "../viewers/ArtifactViewer.tsx";

const VersionView = ({ artifactId, revisionId, label }: { artifactId: string; revisionId: string; label: string }) => {
  const [read, reload] = useQuery(`version:${revisionId}`, (api) =>
    api.call("student.getArtifact", { params: { artifactId }, query: { revisionId } }));
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <Text bold>{label}</Text>
      {read.status === "loading" ? <LoadingSkeleton label={`Loading ${label}`} /> : null}
      {read.status === "error" ? <ErrorState error={read.error} title="We couldn't open this version" onRetry={reload} /> : null}
      {read.status === "ready" ? <ArtifactViewer read={read.data} /> : null}
    </section>
  );
};

/**
 * Every saved version of one piece of work, newest first, each of which can be opened read-only.
 * `headId` is the latest version, so saving again refreshes the list.
 */
export const HistoryPanel = ({ artifactId, headId }: { artifactId: string; headId: string }) => {
  const [history, reload] = useQuery(`history:${artifactId}:${headId}`, (api) => api.call("student.artifactHistory", { params: { artifactId } }));
  const [viewing, setViewing] = useState<{ revisionId: string; label: string } | undefined>(undefined);

  if (history.status === "loading") return <LoadingSkeleton label="Loading saved versions" />;
  if (history.status === "error") return <ErrorState error={history.error} title="We couldn't load your saved versions" onRetry={reload} />;
  const versions = history.data.toSorted((a, b) => b.number - a.number);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-3">
      <ol aria-label="Saved versions" className="flex flex-col gap-2">
        {versions.map((version) => {
          const label = `Version ${version.number}, saved ${formatDateTime(version.createdAt)}`;
          return (
            <li key={version.id} className="flex flex-wrap items-center justify-between gap-2">
              <Text size="sm">
                Version {version.number} · <time dateTime={version.createdAt}>{formatDateTime(version.createdAt)}</time>
                {version.id === headId ? " (latest)" : ""}
              </Text>
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={viewing?.revisionId === version.id}
                aria-label={`View ${label}`}
                onClick={() => setViewing(viewing?.revisionId === version.id ? undefined : { revisionId: version.id, label })}
              >
                View
              </Button>
            </li>
          );
        })}
      </ol>
      {viewing === undefined ? null : <VersionView key={viewing.revisionId} artifactId={artifactId} {...viewing} />}
    </div>
  );
};
