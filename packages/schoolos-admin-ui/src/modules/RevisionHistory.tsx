import { Badge, Button, Text } from "@cloudflare/kumo";
import type { ConfigVersion } from "../app/useDistrictConfig.ts";
import { documentFromDesired } from "../configDocument.ts";
import type { ProposedChange } from "./ChangeReview.tsx";
import { DiffList } from "./PlanSummary.tsx";

interface RevisionHistoryProps {
  /** The versions the console knows, newest first. */
  versions: readonly ConfigVersion[];
  /** Called with the change to preview. */
  onPreview: (change: ProposedChange) => void;
}

/**
 * The configuration versions, what each changed, and rolling back to an earlier one. A roll back
 * is itself a new version, previewed like any other change, so it can be undone the same way.
 */
export const RevisionHistory = ({ versions, onPreview }: RevisionHistoryProps) => (
  <section aria-labelledby="history-heading" className="flex flex-col gap-3">
    <Text as="h3" variant="heading" id="history-heading">History</Text>
    <ol className="flex flex-col gap-3">
      {versions.map((version, index) => (
        <li key={version.revision.id} className="flex flex-col gap-2 rounded-md border border-kumo-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Text bold>Version {version.number}</Text>
            {index === 0 && <Badge variant="success">In force</Badge>}
          </div>
          {version.changes !== undefined && (
            <details>
              <summary className="cursor-pointer">What version {version.number} changed ({version.changes.length})</summary>
              <div className="mt-2"><DiffList diff={version.changes} /></div>
            </details>
          )}
          {index > 0 && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onPreview({ title: `Preview: roll back to version ${version.number}`, document: documentFromDesired(version.desired), applyLabel: "Roll back" })}
              >
                Roll back to version {version.number}
              </Button>
            </div>
          )}
        </li>
      ))}
    </ol>
    <Text variant="secondary" size="sm">Versions made before you opened the console are not listed yet; the latest one is always shown.</Text>
  </section>
);
