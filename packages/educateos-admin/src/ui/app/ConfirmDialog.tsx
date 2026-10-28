import type { ReactNode } from "react";
import { Button, Dialog } from "@cloudflare/kumo";

/** A confirmation for a consequential step: focus is held in it until the operator answers. */
export const ConfirmDialog = ({ open, title, children, confirmLabel, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) => (
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
