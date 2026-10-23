import { useState } from "react";
import { Empty, Text } from "@cloudflare/kumo";
import { Table as TableIcon } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { classLabel } from "../classes/classLabel.ts";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import type { Gradebook, GradeMarker, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { CsvExport } from "./CsvExport.tsx";
import { GradebookGrid, type CellTarget } from "./GradebookGrid.tsx";
import { MarkerDialog } from "./MarkerDialog.tsx";
import { MARKER_LABELS } from "./gradebookText.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

/**
 * A class's gradebook: every enrolled student's official grades, the totals the class's settings
 * make of them, and a letter grade. Only official grades appear; proposals and suggested scores
 * wait on the Submissions screen. The class's teacher sets its groups, weights and scale and marks
 * work excused, missing or late; co-teachers read it.
 */
export const GradebookPage = ({ teaching }: { teaching: TeachingOffering }) => {
  const offeringId = teaching.offering.id;
  const client = useDistrictApi();
  const announce = useAnnounce();
  const gradebook = useLoad(`gradebook:${offeringId}`, (c) => c.call("teacher.gradebook", { params: { offeringId } }));
  // Keep the grid on screen while it reloads after a change, so the teacher's place survives.
  const [last, setLast] = useState<{ offeringId: string; data: Gradebook }>();
  const ready = gradebook.status === "ready" ? gradebook.data : undefined;
  if (ready !== undefined && last?.data !== ready) setLast({ offeringId, data: ready });
  const data = ready ?? (last?.offeringId === offeringId ? last.data : undefined);

  const [editing, setEditing] = useState<CellTarget>();
  const [marking, setMarking] = useState<{ status: "idle" | "saving" } | { status: "failed"; error: unknown }>({ status: "idle" });
  const canEdit = teaching.role === "teacher";

  const saveMarker = async (marker: GradeMarker | null) => {
    if (editing === undefined) return;
    setMarking({ status: "saving" });
    try {
      await client.call("teacher.setGradeMarker", {
        params: { offeringId },
        body: { assignmentId: editing.column.assignmentId, studentPrincipalId: editing.row.studentPrincipalId, marker },
      });
      announce(marker === null
        ? `Cleared the mark on ${editing.column.title} for ${editing.row.displayName}.`
        : `Marked ${editing.column.title} ${MARKER_LABELS[marker].toLowerCase()} for ${editing.row.displayName}.`);
      setMarking({ status: "idle" });
      setEditing(undefined);
      gradebook.reload();
    } catch (error) {
      setMarking({ status: "failed", error });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeading>{`Gradebook · ${classLabel(teaching)}`}</PageHeading>
      <Text variant="secondary">
        {canEdit
          ? "Official grades only. Choose a cell, or move to it with the arrow keys and press Enter, to mark it excused, missing or late."
          : "Official grades only. The class's teacher sets how the totals add up."}
      </Text>
      {gradebook.status === "loading" && data === undefined && <Loading label="Loading the gradebook…" />}
      {gradebook.status === "error" && <Problem error={gradebook.error} onRetry={gradebook.reload} />}
      {data !== undefined && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            {canEdit ? <SettingsDialog gradebook={data} onSaved={gradebook.reload} /> : null}
            <CsvExport offeringId={offeringId} />
          </div>
          {data.rows.length === 0 || data.columns.length === 0 ? (
            <Empty
              icon={<TableIcon size={32} aria-hidden />}
              title={data.rows.length === 0 ? "No students yet" : "Nothing assigned yet"}
              description={data.rows.length === 0 ? "Students appear here once your district enrolls them." : "Each activity you assign becomes a column here."}
            />
          ) : (
            <GradebookGrid
              gradebook={data}
              caption={`Gradebook for ${classLabel(teaching)}`}
              {...(canEdit ? { onOpenCell: (target: CellTarget) => {
                setMarking({ status: "idle" });
                setEditing(target);
              } } : {})}
            />
          )}
        </>
      )}
      <MarkerDialog
        target={editing}
        saving={marking.status === "saving"}
        error={marking.status === "failed" ? marking.error : undefined}
        onSave={(marker) => void saveMarker(marker)}
        onClose={() => setEditing(undefined)}
      />
    </div>
  );
};
