import { Text } from "@cloudflare/kumo";
import type { ArtifactRead } from "../model.ts";
import { CsvTable } from "./CsvTable.tsx";
import { ExternalLinkCard } from "./ExternalLinkCard.tsx";
import { FileViewer } from "./FileViewer.tsx";

/** One saved version of a piece of work, shown the way its kind reads best. */
export const ArtifactViewer = ({ read }: { read: ArtifactRead }) => {
  const { artifact, revision, content } = read;
  switch (content.kind) {
    case "text":
      return revision.mediaType === "text/csv" ? (
        <CsvTable text={content.text} caption={artifact.title} />
      ) : (
        <div className="whitespace-pre-wrap rounded-lg border border-kumo-hairline bg-kumo-elevated p-4">
          {content.text === "" ? <Text variant="secondary">This version is empty.</Text> : content.text}
        </div>
      );
    case "bytes":
      return <FileViewer base64={content.base64} mediaType={revision.mediaType} title={artifact.title} />;
    case "external":
      return <ExternalLinkCard url={content.url} title={artifact.title} />;
  }
};
