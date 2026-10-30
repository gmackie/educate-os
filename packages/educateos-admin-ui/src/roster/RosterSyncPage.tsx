import { useState, type ReactNode } from "react";
import { Badge, Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { ArrowsClockwise, Lightning, Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { count, formatMoment, rosterProviderName } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";
import { RosterSyncHistory } from "./RosterSyncHistory.tsx";
import { RosterSyncResult } from "./RosterSyncResult.tsx";
import { HEALTH, failureReason, modeName, runSummary, sentence, type RosterSyncStatus, type SyncMode, type SyncRun, type SyncRunResult } from "./rosterSync.ts";

type HeldRun = SyncRun & { held: NonNullable<SyncRun["held"]> };

const Fact = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1">
    <dt><Text variant="secondary">{term}</Text></dt>
    <dd>{children}</dd>
  </div>
);

/** Where the roster comes from, whether it can sync, and how healthy its syncs have been. */
const SyncSource = ({ status, provider }: { status: RosterSyncStatus; provider: string }) => {
  const health = status.health;
  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Fact term="Roster source"><Text bold>{provider}</Text></Fact>
        <Fact term="Health">
          {health === undefined
            ? <Text>No schedule</Text>
            : <Badge variant={HEALTH[health.status].variant} appearance="dot">{HEALTH[health.status].label}</Badge>}
        </Fact>
        <Fact term="Last successful sync">
          <Text>{health?.lastSuccessAt === undefined ? "None yet" : formatMoment(health.lastSuccessAt)}</Text>
        </Fact>
        <Fact term="Failures since then">
          <Text>{health === undefined ? "Not tracked" : count(health.consecutiveFailures, "sync")}</Text>
        </Fact>
      </dl>
      {health === undefined
        ? <Text variant="secondary">There is no sync schedule, so the roster syncs only when an administrator runs one here.</Text>
        : health.quarantineBacklog > 0 && <Text variant="secondary">{`${count(health.quarantineBacklog, "person", "people")} from the last successful sync ${health.quarantineBacklog === 1 ? "is" : "are"} held for review.`}</Text>}
      {!status.runnable && (
        <Banner
          variant="alert"
          icon={<Warning weight="fill" />}
          title="The roster cannot sync"
          description={`${sentence(status.reason ?? "the roster integration is not set up")} Set up the roster in the district's configuration, then come back here.`}
        />
      )}
    </LayerCard>
  );
};

/**
 * Roster sync (SCHO-277): where the district's roster comes from (Clever, a OneRoster connection,
 * ...), whether it can sync and how healthy its syncs are; running a complete or delta sync now and
 * what it changed and found; the recent runs; and approving a large removal the sync held.
 */
export const RosterSyncPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const status = useLoad("roster-sync", (c) => c.call("admin.rosterSyncStatus"));
  const [running, setRunning] = useState<SyncMode>();
  const [result, setResult] = useState<SyncRunResult>();
  const [error, setError] = useState<string>();
  const [reviewing, setReviewing] = useState<HeldRun>();
  const provider = status.status === "ready" ? rosterProviderName(status.data.provider) : "The roster provider";

  const run = async (mode: SyncMode) => {
    setRunning(mode);
    setError(undefined);
    try {
      const next = await client.call("admin.runRosterSync", { body: { mode } });
      setResult(next);
      status.reload();
      const ran = next.run;
      announce(ran === undefined ? "No sync ran."
        : ran.outcome === "succeeded" ? `${modeName(mode)} finished. ${runSummary(ran, next.grantsRevoked)}`
        : `${modeName(mode)} failed. ${ran.errorCode === undefined ? "" : failureReason(ran.errorCode, provider)}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(undefined);
    }
  };

  const approve = async (held: HeldRun) => {
    setError(undefined);
    try {
      await client.call("admin.approveRosterRemoval", { body: { fingerprint: held.held.fingerprint } });
      announce("Removal approved. Run the sync again to apply it.");
      status.reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Text as="h2" variant="heading" size="lg">Roster sync</Text>
        <Text variant="secondary">
          EducateOS keeps its schools, classes and people in step with the district's roster. A sync reads the roster, applies what changed,
          and holds back anyone it cannot match to a sign-in. People and enrollments the roster drops are deactivated, never deleted.
        </Text>
      </div>
      {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="That did not work" description={error} />}
      <LoadState loaded={status} what="the roster sync" onRetry={status.reload}>
        {(s) => {
          const latest = s.runs.at(-1);
          const held = latest?.held === undefined ? undefined : latest as HeldRun;
          return (
            <>
              <section aria-labelledby="sync-source-heading" className="flex flex-col gap-3">
                <Text as="h3" variant="heading" id="sync-source-heading">Source</Text>
                <SyncSource status={s} provider={provider} />
                {held !== undefined && s.approvedRemoval !== held.held.fingerprint && (
                  <Banner
                    variant="alert"
                    icon={<Warning weight="fill" />}
                    title="The last sync is waiting for approval"
                    description={`It would deactivate ${count(held.held.principals.deactivated, "person", "people")} of ${held.held.principals.active.toLocaleString("en-US")} and ${count(held.held.enrollments.deactivated, "enrollment")} of ${held.held.enrollments.active.toLocaleString("en-US")}. Nothing was applied.`}
                    action={<Button size="sm" onClick={() => setReviewing(held)}>Review removal</Button>}
                  />
                )}
                {s.approvedRemoval !== undefined && (
                  <Text variant="secondary">A removal is approved. The next sync applies it, if the roster still matches what was approved.</Text>
                )}
              </section>
              <section aria-labelledby="sync-run-heading" className="flex flex-col gap-3">
                <Text as="h3" variant="heading" id="sync-run-heading">Sync now</Text>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="flex flex-col items-start gap-2">
                    <Button variant="primary" icon={<ArrowsClockwise />} disabled={!s.runnable || running !== undefined} loading={running === "complete"} onClick={() => void run("complete")}>
                      Run complete sync
                    </Button>
                    <Text variant="secondary" size="sm">Reads the whole roster from {provider}. Anyone it no longer lists is deactivated.</Text>
                  </div>
                  <div className="flex flex-col items-start gap-2">
                    <Button variant="secondary" icon={<Lightning />} disabled={!s.runnable || running !== undefined} loading={running === "delta"} onClick={() => void run("delta")}>
                      Run delta sync
                    </Button>
                    <Text variant="secondary" size="sm">Reads only what changed since the last sync. Quicker, but only a complete sync notices records deleted outright.</Text>
                  </div>
                </div>
              </section>
              {result !== undefined && <RosterSyncResult result={result} provider={provider} />}
              <RosterSyncHistory runs={s.runs} provider={provider} />
            </>
          );
        }}
      </LoadState>
      <ConfirmDialog
        open={reviewing !== undefined}
        title="Approve this removal?"
        confirmLabel="Approve removal"
        onConfirm={() => {
          const held = reviewing!;
          setReviewing(undefined);
          void approve(held);
        }}
        onCancel={() => setReviewing(undefined)}
      >
        <p>{`The next sync will deactivate ${count(reviewing?.held.principals.deactivated ?? 0, "person", "people")} and ${count(reviewing?.held.enrollments.deactivated ?? 0, "enrollment")}, if the roster still says the same.`}</p>
        <p>A roster cut short or scoped to the wrong schools looks just like this. Check {provider} first. Deactivated people and enrollments are kept, not deleted.</p>
      </ConfirmDialog>
    </div>
  );
};
