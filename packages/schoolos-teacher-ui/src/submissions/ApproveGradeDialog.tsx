import { Button, Dialog } from "@cloudflare/kumo";
import { Seal } from "@phosphor-icons/react";

/**
 * The confirmation every official grade goes through. It says plainly that this is the official
 * grade, for whom and of what, before the teacher commits to it.
 */
export const ApproveGradeDialog = ({ student, points, maxPoints, disabled, busy, onApprove }: {
  student: string;
  points: number;
  maxPoints: number;
  disabled: boolean;
  busy: boolean;
  onApprove: () => void;
}) => (
  <Dialog.Root>
    <Dialog.Trigger render={(props) => <Button {...props} variant="primary" icon={<Seal aria-hidden />} disabled={disabled} loading={busy}>Approve official grade</Button>} />
    <Dialog className="flex flex-col gap-4 p-6" size="lg">
      <Dialog.Title className="text-lg font-semibold">Approve the official grade?</Dialog.Title>
      <Dialog.Description>
        {`This is the official grade: ${points} out of ${maxPoints} for ${student}. It is recorded in ${student}’s grades and can be sent to your district's grade book. Suggestions count only where you entered them as your own scores.`}
      </Dialog.Description>
      <div className="flex flex-wrap justify-end gap-2">
        <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
        <Dialog.Close render={(props) => <Button {...props} variant="primary" onClick={onApprove}>Yes, approve official grade</Button>} />
      </div>
    </Dialog>
  </Dialog.Root>
);
