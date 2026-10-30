import { useState } from "react";
import { Banner, Button } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import type { DemoRoster, RosterSyncResult } from "./districts/index.ts";

interface CleverSyncPanelProps {
  roster: DemoRoster;
  /** Called once a sync has succeeded, so the admin console can reread the district. */
  onSynced: () => void;
}

type SyncState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: RosterSyncResult }
  | { status: "failed" };

/** What one run changed, in a sentence. */
const describeRun = ({ run }: RosterSyncResult): string => {
  if (run === undefined) return "No sync ran.";
  if (run.outcome === "failed") return `The sync stopped (${run.errorCode ?? "unknown error"}). Nothing changed.`;
  const { principals, offerings } = run.counts;
  if (principals.added + principals.updated + principals.deactivated + offerings.added + offerings.updated + offerings.deactivated === 0) {
    return "Synced from Clever: everything was already up to date.";
  }
  return `Synced from Clever: ${principals.added} people and ${offerings.added} classes added, ${principals.updated + offerings.updated} updated, ${principals.deactivated + offerings.deactivated} removed.`;
};

/**
 * The administrator's way to run the district's Clever roster sync in the demo, above the admin
 * console, which has no roster sync screen of its own yet. It runs the same `admin.runRosterSync`
 * a district's scheduled sync does.
 */
export const CleverSyncPanel = ({ roster, onSynced }: CleverSyncPanelProps) => {
  const [state, setState] = useState<SyncState>({ status: "idle" });
  const run = async () => {
    setState({ status: "running" });
    try {
      const result = await roster.sync();
      setState({ status: "done", result });
      if (result.run?.outcome === "succeeded") onSynced();
    } catch {
      setState({ status: "failed" });
    }
  };
  const synced = roster.synced();
  const description = state.status === "done"
    ? describeRun(state.result)
    : state.status === "failed"
    ? "The sync didn't run. Try again."
    : synced
    ? "This district's people and classes come from Clever. Sync again to pick up changes."
    : "This district's people and classes come from Clever, and nothing has synced yet. Run the first sync to bring them in.";
  return (
    <div className="px-4 pt-4">
      <Banner
        variant={state.status === "failed" ? "error" : "secondary"}
        icon={<ArrowsClockwiseIcon aria-hidden />}
        title="Clever roster sync"
        description={<span role="status">{description}</span>}
        action={(
          <Button size="sm" variant="primary" loading={state.status === "running"} onClick={() => void run()}>
            {synced ? "Sync again" : "Run Clever sync"}
          </Button>
        )}
      />
    </div>
  );
};
