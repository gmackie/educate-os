import { useState } from "react";
import { Badge, Input, LayerCard, Text } from "@cloudflare/kumo";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { GradeProposal, OfficialGrade as OfficialGradeVersion } from "../types.ts";
import { ApproveGradeDialog } from "./ApproveGradeDialog.tsx";

/**
 * The official grade. It starts from the teacher's own criterion scores and is recorded only
 * through {@link ApproveGradeDialog}. A co-teacher's grade waits for the lead teacher, who
 * approves it the same way.
 */
export const OfficialGrade = ({ submissionId, student, suggestedTotal, proposals, onChanged }: {
  submissionId: string;
  student: string;
  /** What the teacher's own criterion scores add up to, if every criterion has one. */
  suggestedTotal: { points: number; maxPoints: number } | undefined;
  proposals: readonly GradeProposal[];
  onChanged: () => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [points, setPoints] = useState<string | undefined>(undefined);
  const [maxPoints, setMaxPoints] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<
    { status: "idle" | "sending" } | { status: "official"; version: OfficialGradeVersion } | { status: "proposed" } | { status: "failed"; error: unknown }
  >({ status: "idle" });

  const pointsText = points ?? (suggestedTotal === undefined ? "" : String(suggestedTotal.points));
  const maxText = maxPoints ?? (suggestedTotal === undefined ? "" : String(suggestedTotal.maxPoints));
  const score = { points: Number(pointsText), maxPoints: Number(maxText) };
  const valid = pointsText.trim() !== "" && maxText.trim() !== "" && Number.isFinite(score.points) && Number.isFinite(score.maxPoints) && score.maxPoints > 0 && score.points >= 0 && score.points <= score.maxPoints;

  const record = async () => {
    setResult({ status: "sending" });
    try {
      const recorded = await client.call("teacher.recordGrade", { params: { submissionId }, body: { score } });
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

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <h2><Text variant="heading" as="span">Official grade</Text></h2>
      {result.status === "official" && (
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="success">Official</Badge>
          <Text as="span">{`${result.version.score.points} out of ${result.version.score.maxPoints}, approved ${new Date(result.version.approval.approvedAt).toLocaleString()} (version ${result.version.version}).`}</Text>
        </p>
      )}
      {result.status === "proposed" && <Text>Your grade is waiting for the lead teacher to approve it.</Text>}
      {proposals.filter((p) => p.approvedAsVersion === undefined).map((proposal) => (
        <div key={proposal.id} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
          <Text>{`A co-teacher proposed ${proposal.score.points} out of ${proposal.score.maxPoints}. It isn't official until you approve it.`}</Text>
          <ApproveGradeDialog student={student} points={proposal.score.points} maxPoints={proposal.score.maxPoints} disabled={false} busy={result.status === "sending"} onApprove={() => void approve(proposal)} />
        </div>
      ))}
      <Text variant="secondary" size="sm">Starts from your own rubric scores. Suggested scores aren't included until you save them as yours.</Text>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Points" inputMode="decimal" value={pointsText} onChange={(event) => setPoints(event.target.value)} />
        <Input label="Out of" inputMode="decimal" value={maxText} onChange={(event) => setMaxPoints(event.target.value)} />
      </div>
      <div>
        <ApproveGradeDialog student={student} points={score.points} maxPoints={score.maxPoints} disabled={!valid} busy={result.status === "sending"} onApprove={() => void record()} />
      </div>
      {result.status === "failed" && <Problem error={result.error} />}
    </LayerCard>
  );
};
