import { useState } from "react";
import { Button, Dialog, Radio } from "@cloudflare/kumo";
import { Problem } from "../Problem.tsx";
import type { GradeMarker } from "../types.ts";
import type { CellTarget } from "./GradebookGrid.tsx";
import { MARKER_LABELS } from "./gradebookText.ts";

const CHOICES: readonly { value: GradeMarker | "none"; label: string; description: string }[] = [
  { value: "none", label: "No mark", description: "The grade counts as recorded, or not at all until there is one." },
  { value: "excused", label: MARKER_LABELS.excused, description: "Left out of every total, even if graded." },
  { value: "missing", label: MARKER_LABELS.missing, description: "Until it is graded, counts as zero if the gradebook settings say so." },
  { value: "late", label: MARKER_LABELS.late, description: "Shown beside the grade. It changes no total." },
];

const MarkerForm = ({ target, saving, error, onSave }: {
  target: CellTarget;
  saving: boolean;
  error: unknown;
  onSave: (marker: GradeMarker | null) => void;
}) => {
  const [choice, setChoice] = useState<GradeMarker | "none">(target.cell.marker ?? "none");
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(choice === "none" ? null : choice);
      }}
    >
      <Dialog.Title className="text-lg font-semibold">{`${target.row.displayName} · ${target.column.title}`}</Dialog.Title>
      <Dialog.Description>Marks change how the gradebook adds up. They never change an official grade.</Dialog.Description>
      <Radio.Group legend="Mark" value={choice} onValueChange={(value) => setChoice(value as GradeMarker | "none")}>
        {CHOICES.map((c) => <Radio.Item key={c.value} value={c.value} label={c.label} description={c.description} />)}
      </Radio.Group>
      {error === undefined ? null : <Problem error={error} />}
      <div className="flex flex-wrap justify-end gap-2">
        <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
        <Button type="submit" variant="primary" loading={saving}>Save mark</Button>
      </div>
    </form>
  );
};

/** Marks one student's assignment excused, missing or late, or clears its mark. */
export const MarkerDialog = ({ target, saving, error, onSave, onClose }: {
  target: CellTarget | undefined;
  saving: boolean;
  error: unknown;
  onSave: (marker: GradeMarker | null) => void;
  onClose: () => void;
}) => (
  <Dialog.Root open={target !== undefined} onOpenChange={(open) => open || onClose()}>
    <Dialog className="p-6" size="lg">
      {target === undefined ? null : (
        <MarkerForm key={`${target.row.studentPrincipalId}:${target.column.assignmentId}`} target={target} saving={saving} error={error} onSave={onSave} />
      )}
    </Dialog>
  </Dialog.Root>
);
