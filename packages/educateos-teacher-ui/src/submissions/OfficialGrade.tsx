import { useState } from "react";
import { Badge, Button, Input, LayerCard, Text } from "@cloudflare/kumo";
import { PencilSimple } from "@phosphor-icons/react";
import { Loading } from "../Loading.tsx";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { GradeProposal, OfficialGrade as OfficialGradeVersion } from "../types.ts";
import { ApproveGradeDialog } from "./ApproveGradeDialog.tsx";
import { DeclineGradeDialog } from "./DeclineGradeDialog.tsx";
import { formatDateTime } from "../dates.ts";

/**
 * The official grade. Once there is one it is shown as it stands, and grading again is an explicit
 * change rather than an empty form that invites approving twice. A new grade starts from the
 * teacher's own criterion scores and is recorded only through {@link ApproveGradeDialog}. A
 * co-teacher's grade waits for the lead teacher, who approves it the same way or declines it with
 * a reason.
 */
export const OfficialGrade = ({ submissionId, student, suggestedTotal, proposals, official, officialLoading, onChanged }: {
  submissionId: string;
  student: string;
  /** What the teacher's own criterion scores add up to, if every criterion has one. */
  suggestedTotal: { points: number; maxPoints: number } | undefined;
  proposals: readonly GradeProposal[];
  /** The student's current official grade for the assignment, if any. */
  official: OfficialGradeVersion | undefined;
  officialLoading: boolean;
  onChanged: () => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [points, setPoints] = useState<string | undefined>(undefined);
  const [maxPoints, setMaxPoints] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<
    { status: "idle" | "sending" } | { status: "official"; version: OfficialGradeVersion } | { status: "proposed" } | { status: "declined" } | { status: "failed"; error: unknown }
  >({ status: "idle" });
  const [changing, setChanging] = useState(false);
  // The grade just recorded shows at once, before the reload that brings it back catches up.
  const justRecorded = result.status === "official" ? result.version : undefined;
  const current = justRecorded !== undefined && (official === undefined || justRecorded.version >= official.version) ? justRecorded : official;
  const showForm = current === undefined || changing;

  const pointsText = points ?? (suggestedTotal === undefined ? "" : String(suggestedTotal.points));
  const maxText = maxPoints ?? (suggestedTotal === undefined ? "" : String(suggestedTotal.maxPoints));
  const score = { points: Number(pointsText), maxPoints: Number(maxText) };
  const valid = pointsText.trim() !== "" && maxText.trim() !== "" && Number.isFinite(score.points) && Number.isFinite(score.maxPoints) && score.maxPoints > 0 && score.points >= 0 && score.points <= score.maxPoints;

  const record = async () => {
    setResult({ status: "sending" });
    try {
      const recorded = await client.call("teacher.recordGrade", { params: { submissionId }, body: { score } });
      setChanging(false);
      setPoints(undefined);
      setMaxPoints(undefined);
      if (recorded.status === "official") {
        setResult({ status: "official", version: recorded.version });
        announce(`Official grade recorded: ${recorded.version.score.points} out of ${recorded.version.score.maxPoints}.`);
      } else {
        setResult({ status: "proposed" });
        announce("Grade sent to the lead teacher for approval.");
      }
      onChanged();
    } catch (error) {
      setResult({ status: "failed", error });
    }
  };

  const approve = async (proposal: GradeProposal) => {
    setResult({ status: "sending" });
    try {
      const version = await client.call("teacher.approveGrade", { params: { proposalId: proposal.id } });
      setResult({ status: "official", version });
      announce(`Official grade recorded: ${version.score.points} out of ${version.score.maxPoints}.`);
      onChanged();
    } catch (error) {
      setResult({ status: "failed", error });
    }
  };

  const decline = async (proposal: GradeProposal, reason: string) => {
    setResult({ status: "sending" });
    try {
      await client.call("teacher.declineGradeProposal", { params: { proposalId: proposal.id }, body: { reason } });
      setResult({ status: "declined" });
      announce("Proposed grade declined. It won't become official.");
      onChanged();
    } catch (error) {
      setResult({ status: "failed", error });
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <h2><Text variant="heading" as="span">Official grade</Text></h2>
      {officialLoading && current === undefined && <Loading label="Loading the official grade…" />}
      {current !== undefined && (
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant="success">Official</Badge>
            <Text bold size="lg" as="span">{`${current.score.points} out of ${current.score.maxPoints}`}</Text>
          </p>
          <Text variant="secondary" size="sm">
            {`Approved ${formatDateTime(current.approval.approvedAt)}${current.version > 1 ? ` (changed ${current.version - 1} ${current.version === 2 ? "time" : "times"})` : ""}.${current.submissionId === submissionId ? "" : " This grade is for another attempt."}`}
          </Text>
          {!changing && (
            <div>
              <Button icon={<PencilSimple aria-hidden />} onClick={() => setChanging(true)}>Change the official grade</Button>
            </div>
          )}
        </div>
      )}
      {result.status === "proposed" && <Text>Your grade is waiting for the lead teacher to approve it.</Text>}
      {result.status === "declined" && <Text>You declined the proposed grade. It won't become official.</Text>}
      {proposals.filter((p) => p.approvedAsVersion === undefined).map((proposal) => (
        <div key={proposal.id} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
          <Text>{`A co-teacher proposed ${proposal.score.points} out of ${proposal.score.maxPoints}. It isn't official until you approve it.`}</Text>
          <div className="flex flex-wrap gap-2">
            <ApproveGradeDialog student={student} points={proposal.score.points} maxPoints={proposal.score.maxPoints} disabled={false} busy={result.status === "sending"} onApprove={() => void approve(proposal)} />
            <DeclineGradeDialog student={student} points={proposal.score.points} maxPoints={proposal.score.maxPoints} busy={result.status === "sending"} onDecline={(reason) => void decline(proposal, reason)} />
          </div>
        </div>
      ))}
      {showForm && !(officialLoading && current === undefined) && (
        <>
          <Text variant="secondary" size="sm">
            {current === undefined
              ? "Starts from your own rubric scores. Suggested scores aren't included until you save them as yours."
              : "The new grade replaces the official one. Both stay in the grade's history."}
          </Text>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Points" inputMode="decimal" value={pointsText} onChange={(event) => setPoints(event.target.value)} />
            <Input label="Out of" inputMode="decimal" value={maxText} onChange={(event) => setMaxPoints(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <ApproveGradeDialog student={student} points={score.points} maxPoints={score.maxPoints} disabled={!valid} busy={result.status === "sending"} onApprove={() => void record()} />
            {changing && <Button variant="ghost" onClick={() => setChanging(false)}>Keep the current grade</Button>}
          </div>
        </>
      )}
      {result.status === "failed" && <Problem error={result.error} />}
    </LayerCard>
  );
};
