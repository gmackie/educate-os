import { useState } from "react";
import { Button, Dialog, Radio } from "@cloudflare/kumo";
import { ConfirmDialog } from "../app/ConfirmDialog.tsx";
import { SUSPEND_REASONS, type GuardianStanding, type SuspendReason } from "./guardianLabels.ts";

interface RelationshipActionsProps {
  guardianName: string;
  studentName: string;
  standing: GuardianStanding;
  /** What the relationship lets the guardian read, in the administrator's words. */
  readable: readonly string[];
  /** How many classes it is limited to, or undefined for all of the student's classes. */
  classCount: number | undefined;
  /** Whether a change is in flight, which disables every action. */
  busy: boolean;
  onConfirm: () => Promise<void>;
  onSuspend: (reason: SuspendReason) => Promise<void>;
  onResume: () => Promise<void>;
  onRevoke: () => Promise<void>;
}

type Asking = "confirm" | "suspend" | "revoke" | undefined;

/**
 * What an administrator can do to one relationship in its standing. Confirming, suspending and
 * ending each ask first, since each changes what the guardian can read about the student at once.
 */
export const RelationshipActions = ({ guardianName, studentName, standing, readable, classCount, busy, onConfirm, onSuspend, onResume, onRevoke }: RelationshipActionsProps) => {
  const [asking, setAsking] = useState<Asking>();
  const [reason, setReason] = useState<SuspendReason>("court-order-review");
  const answer = (change: () => Promise<void>) => {
    setAsking(undefined);
    void change();
  };

  return (
    <div className="flex flex-wrap gap-2">
      {standing === "awaiting-confirmation" && (
        <Button size="sm" variant="primary" disabled={busy} aria-label={`Confirm ${guardianName}`} onClick={() => setAsking("confirm")}>Confirm</Button>
      )}
      {(standing === "active" || standing === "expired") && (
        <Button size="sm" variant="secondary" disabled={busy} aria-label={`Suspend ${guardianName}`} onClick={() => setAsking("suspend")}>Suspend</Button>
      )}
      {standing === "suspended" && (
        <Button size="sm" variant="secondary" disabled={busy} aria-label={`Restore ${guardianName}'s access`} onClick={() => void onResume()}>Restore access</Button>
      )}
      {standing !== "ended" && (
        <Button size="sm" variant="secondary" disabled={busy} aria-label={`End ${guardianName}'s relationship`} onClick={() => setAsking("revoke")}>End</Button>
      )}

      <ConfirmDialog
        open={asking === "confirm"}
        title={`Confirm ${guardianName} as ${studentName}'s guardian?`}
        confirmLabel="Confirm guardian"
        onConfirm={() => answer(onConfirm)}
        onCancel={() => setAsking(undefined)}
      >
        <p>{guardianName} will be able to read, of {classCount === undefined ? `all of ${studentName}'s classes` : classCount === 1 ? `one of ${studentName}'s classes` : `${classCount} of ${studentName}'s classes`}:</p>
        <ul className="list-disc pl-5">{readable.map((kind) => <li key={kind}>{kind}</li>)}</ul>
        <p>They can never change anything, and never see {studentName}'s own work, personal space or conversations.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={asking === "revoke"}
        title={`End ${guardianName}'s relationship to ${studentName}?`}
        confirmLabel="End relationship"
        onConfirm={() => answer(onRevoke)}
        onCancel={() => setAsking(undefined)}
      >
        <p>{guardianName} stops seeing anything about {studentName} at once.</p>
        <p>The relationship is kept on record and cannot be restarted. To connect them again, send a new invitation.</p>
      </ConfirmDialog>

      <Dialog.Root role="alertdialog" open={asking === "suspend"} onOpenChange={(next) => { if (!next) setAsking(undefined); }}>
        <Dialog className="p-6" size="lg">
          <Dialog.Title className="mb-3 text-lg font-semibold">{`Suspend ${guardianName}'s access?`}</Dialog.Title>
          <Dialog.Description className="mb-4 text-kumo-default">
            {guardianName} stops seeing anything about {studentName} until you restore access. Only the reason's category is recorded.
          </Dialog.Description>
          <Radio.Group legend="Reason" value={reason} onValueChange={(value) => setReason(value as SuspendReason)}>
            {(Object.entries(SUSPEND_REASONS) as [SuspendReason, string][]).map(([code, label]) => <Radio.Item key={code} value={code} label={label} />)}
          </Radio.Group>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setAsking(undefined)}>Cancel</Button>
            <Button variant="primary" onClick={() => answer(() => onSuspend(reason))}>Suspend access</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
};
