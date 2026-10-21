import type { ReactNode } from "react";
import { Button, Dialog } from "@cloudflare/kumo";

interface ConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** The question, such as "Apply this roster import?". */
  title: string;
  /** What confirming does. */
  children: ReactNode;
  /** The confirm button's label. */
  confirmLabel: string;
  /** Called when the administrator confirms. */
  onConfirm: () => void;
  /** Called when the administrator cancels, by button, Escape or the backdrop. */
  onCancel: () => void;
}

/** A confirmation for a consequential step. It is an alert dialog: focus is held in it until the administrator answers. */
export const ConfirmDialog = ({ open, title, children, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) => (
  <Dialog.Root role="alertdialog" open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    <Dialog className="p-6" size="lg">
      <Dialog.Title className="mb-3 text-lg font-semibold">{title}</Dialog.Title>
      <Dialog.Description render={(props) => <div {...props} className="flex flex-col gap-2 text-kumo-default" />}>{children}</Dialog.Description>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  </Dialog.Root>
);
