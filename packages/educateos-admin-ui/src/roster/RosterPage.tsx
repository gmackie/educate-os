import { useId, useState } from "react";
import { Banner, Button, Table, Text } from "@cloudflare/kumo";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { count } from "../app/labels.ts";
import { LoadState } from "../app/LoadState.tsx";
import { errorMessage, useLoad } from "../app/useLoad.ts";
import { RosterPreview, type RosterPreviewBody } from "./RosterPreview.tsx";

/** A OneRoster bulk export file name, as the district accepts it: `users.csv`, `enrollments.csv`, ... */
const ONEROSTER_FILE = /^[A-Za-z]+\.csv$/;

/** One import applied in this session. */
interface SyncRecord {
  at: Date;
  files: number;
  added: number;
  updated: number;
  deactivated: number;
  quarantined: number;
  grantsRevoked: number;
}

type Step =
  | { kind: "choose" }
  | { kind: "previewing" }
  | { kind: "previewed"; files: Record<string, string>; preview: RosterPreviewBody }
  | { kind: "applying"; files: Record<string, string>; preview: RosterPreviewBody };

function totals(preview: RosterPreviewBody, key: "added" | "updated" | "deactivated"): number {
  const { schools, terms, courses, offerings, principals, enrollments } = preview.changes;
  return [schools, terms, courses, offerings, principals, enrollments].reduce((n, c) => n + c[key].length, 0);
}

/** Reads the chosen files, or says which names the district would refuse. */
async function readExport(list: FileList | null): Promise<{ files: Record<string, string> } | { error: string }> {
  const chosen = [...(list ?? [])];
  if (chosen.length === 0) return { error: "Choose the CSV files of a OneRoster export." };
  const refused = chosen.filter((f) => !ONEROSTER_FILE.test(f.name)).map((f) => f.name);
  if (refused.length > 0) return { error: `These are not OneRoster CSV file names: ${refused.join(", ")}.` };
  return { files: Object.fromEntries(await Promise.all(chosen.map(async (f) => [f.name, await f.text()] as const))) };
}

/**
 * Roster import: upload a OneRoster CSV export, preview what it changes and who is held for
 * review, then apply it. Applying never deletes anything; people and enrollments the export no
 * longer lists are deactivated and kept.
 */
export const RosterPage = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const inputId = useId();
  const health = useLoad("health", (c) => c.call("admin.health"));
  const [fileList, setFileList] = useState<FileList | null>(null);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<SyncRecord[]>([]);

  const preview = async () => {
    setError(undefined);
    setStep({ kind: "previewing" });
    try {
      const read = await readExport(fileList);
      if ("error" in read) {
        setError(read.error);
        setStep({ kind: "choose" });
        return;
      }
      const result = await client.call("admin.previewRoster", { body: { files: read.files } });
      setStep({ kind: "previewed", files: read.files, preview: result });
      announce(`Preview ready: ${count(result.quarantined.length, "user")} held for review.`);
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "choose" });
    }
  };

  const apply = async () => {
    if (step.kind !== "previewed") return;
    setConfirming(false);
    setStep({ ...step, kind: "applying" });
    try {
      const result = await client.call("admin.applyRoster", { body: { files: step.files } });
      if (!result.applied) {
        setStep({ kind: "previewed", files: step.files, preview: result.preview });
        setError("The roster changed since the preview and this export can no longer be applied. Review the new preview.");
        return;
      }
      setHistory([{
        at: new Date(),
        files: Object.keys(step.files).length,
        added: totals(result.preview, "added"),
        updated: totals(result.preview, "updated"),
        deactivated: totals(result.preview, "deactivated"),
        quarantined: result.preview.quarantined.length,
        grantsRevoked: result.grantsRevoked,
      }, ...history]);
      setStep({ kind: "choose" });
      health.reload();
      announce("The roster import was applied.");
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "previewed", files: step.files, preview: step.preview });
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Text as="h2" variant="heading" size="lg">Roster</Text>

      <section aria-labelledby="import-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="import-heading">Import a OneRoster export</Text>
        <div className="flex flex-col gap-1">
          <label htmlFor={inputId} className="font-medium">OneRoster CSV files</label>
          <Text variant="secondary" size="sm">Choose every file of the export at once: orgs.csv, academicSessions.csv, courses.csv, classes.csv, users.csv, roles.csv and enrollments.csv.</Text>
          <input
            id={inputId}
            type="file"
            accept=".csv,text/csv"
            multiple
            className="max-w-full rounded-md border border-kumo-line bg-kumo-control p-2 focus-visible:outline-2 focus-visible:outline-kumo-focus"
            onChange={(event) => { setFileList(event.target.files); setStep({ kind: "choose" }); }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void preview()} loading={step.kind === "previewing"} disabled={fileList === null || fileList.length === 0}>
            Preview import
          </Button>
          {(step.kind === "previewed" || step.kind === "applying") && (
            <Button onClick={() => setConfirming(true)} disabled={!step.preview.canApply} loading={step.kind === "applying"}>Apply import</Button>
          )}
        </div>
        {error !== undefined && <Banner variant="error" icon={<Warning weight="fill" />} title="Roster import" description={error} />}
        {history[0] !== undefined && step.kind === "choose" && (
          <Banner icon={<CheckCircle weight="fill" />} title="Import applied" description={`${count(history[0].added, "record")} added, ${count(history[0].updated, "record")} updated, ${count(history[0].deactivated, "record")} deactivated. Nothing was deleted.`} />
        )}
        {(step.kind === "previewed" || step.kind === "applying") && <RosterPreview preview={step.preview} />}
      </section>

      <ConfirmDialog open={confirming} title="Apply this roster import?" confirmLabel="Apply import" onCancel={() => setConfirming(false)} onConfirm={() => void apply()}>
        <p>Nothing is deleted. People and enrollments this export no longer lists are deactivated and kept, with all their work.</p>
        {step.kind === "previewed" && (
          <p>
            {count(totals(step.preview, "added"), "record")} will be added, {count(totals(step.preview, "updated"), "record")} updated and {count(totals(step.preview, "deactivated"), "record")} deactivated. {count(step.preview.quarantined.length, "user")} held for review will be left as they are.
          </p>
        )}
      </ConfirmDialog>

      <section aria-labelledby="sync-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="sync-heading">Sync history and health</Text>
        <LoadState loaded={health} what="roster health" onRetry={health.reload}>
          {(h) => (
            <Text>
              The directory holds {count(h.directory.schools, "school")}, {count(h.directory.terms, "term")}, {count(h.directory.offerings, "class", "classes")}, {count(h.directory.students, "student")}, {count(h.directory.staff, "staff member")} and {count(h.directory.activeEnrollments, "active enrollment")}.
            </Text>
          )}
        </LoadState>
        {history.length === 0 ? <Text variant="secondary">No imports applied in this session. Earlier sync runs are not listed yet.</Text> : (
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">Roster imports applied in this session</caption>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Applied</Table.Head>
                  <Table.Head>Files</Table.Head>
                  <Table.Head>Added</Table.Head>
                  <Table.Head>Updated</Table.Head>
                  <Table.Head>Deactivated</Table.Head>
                  <Table.Head>Held for review</Table.Head>
                  <Table.Head>Access removed</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {history.map((run) => (
                  <Table.Row key={run.at.toISOString()}>
                    <Table.Cell>{run.at.toLocaleString()}</Table.Cell>
                    <Table.Cell>{run.files}</Table.Cell>
                    <Table.Cell>{run.added}</Table.Cell>
                    <Table.Cell>{run.updated}</Table.Cell>
                    <Table.Cell>{run.deactivated}</Table.Cell>
                    <Table.Cell>{run.quarantined}</Table.Cell>
                    <Table.Cell>{run.grantsRevoked}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
};
