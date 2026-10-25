import { useState } from "react";
import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { XCircle } from "@phosphor-icons/react";

/**
 * Declining a proposed grade, with the reason the district records beside it. A declined grade
 * never becomes official; the lead teacher can still record their own.
 */
export const DeclineGradeDialog = ({ student, points, maxPoints, busy, onDecline }: {
  student: string;
  points: number;
  maxPoints: number;
  busy: boolean;
  onDecline: (reason: string) => void;
}) => {
  const [reason, setReason] = useState("");
  return (
    <Dialog.Root onOpenChange={(open) => open || setReason("")}>
      <Dialog.Trigger render={(props) => <Button {...props} variant="secondary-destructive" icon={<XCircle aria-hidden />} loading={busy}>Decline proposed grade</Button>} />
      <Dialog className="flex flex-col gap-4 p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold">Decline the proposed grade?</Dialog.Title>
        <Dialog.Description>
          {`${points} out of ${maxPoints} for ${student} won't become official. You can still record a grade yourself.`}
        </Dialog.Description>
        <InputArea label="Reason" description="Recorded with the proposal." value={reason} onValueChange={setReason} />
        <div className="flex flex-wrap justify-end gap-2">
          <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
          <Dialog.Close render={(props) => <Button {...props} variant="destructive" disabled={reason.trim() === ""} onClick={() => onDecline(reason.trim())}>Decline grade</Button>} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
};
