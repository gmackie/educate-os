import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { useLoad } from "../useLoad.ts";
import type { CoverageRow } from "./CoverageTable.tsx";
import { MASTERY_LABELS } from "./practice.ts";
import { PlannerJudgmentHistory } from "../planner/PlannerJudgmentHistory.tsx";

/** One student's shared evidence on one standard. */
export const EvidenceStudentCard = ({ student, code }: { student: RouteResponse<"teacher.guidanceEvidence">["students"][number]; code: string }) => (
  <Surface as="article" aria-label={`${student.displayName}, ${code}`} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
    <div className="flex flex-wrap items-center gap-2">
      <Text as="h4" variant="heading">{student.displayName}</Text>
      <Badge variant={student.state === "independent-reviewed" ? "success" : student.state === "needs-evidence" ? "neutral" : "info"}>{MASTERY_LABELS[student.state]}</Badge>
    </div>
    {student.evidence.length === 0 && <Text variant="secondary">No work shared on this standard yet.</Text>}
    {student.evidence.map((item) => (
      <div key={item.opportunityId} className="flex flex-col gap-2 border-t border-kumo-line pt-2">
        <Text variant="secondary" size="sm">{item.source === "teacher" ? "From a teacher invitation" : "From the student's own goal; only the response below was shared"}</Text>
        <Text>{item.task}</Text>
        {item.response === undefined
          ? <Text variant="secondary">Offered. No response shared.</Text>
          : <>
            <p className="m-0 whitespace-pre-wrap">{item.response.text}</p>
            <Text variant="secondary" size="sm">Shared <time dateTime={item.response.sharedAt}>{item.response.sharedAt.slice(0, 10)}</time> · help the student disclosed: {item.response.assistance}</Text>
          </>}
        {item.reviews.length > 0 && <PlannerJudgmentHistory reviews={item.reviews} criteria={item.rubricCriteria} />}
        <details>
          <summary>Evidence criteria</summary>
          <ul className="list-disc pl-5">{item.criteria.map((c) => <li key={c}>{c}</li>)}</ul>
        </details>
      </div>
    ))}
  </Surface>
);

/**
 * The drill-down for one standard: each student's state with the work they chose to share and the
 * teacher's review history. Nothing else is ever shown here: no chats, no private goals, no unshared drafts.
 */
export const EvidenceDrillDown = ({ offeringId, row, onClose }: { offeringId: string; row: CoverageRow; onClose: () => void }) => {
  const detail = useLoad(`guidance-evidence:${offeringId}:${row.frameworkKey}:${row.code}`, (client) =>
    client.call("teacher.guidanceEvidence", { params: { offeringId: offeringId as never, frameworkKey: row.frameworkKey, code: row.code } }));
  return (
    <section aria-labelledby="evidence-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Text as="h3" variant="heading"><span id="evidence-heading">{`Student evidence for ${row.code}`}</span></Text>
        <Button size="sm" onClick={onClose}>Close student evidence</Button>
      </div>
      <Text variant="secondary">Only work a student chose to share appears here, plus your own invitations and reviews. Chats, private goals and unshared drafts are never shown.</Text>
      {detail.status === "loading" && <Loading label="Loading student evidence…" />}
      {detail.status === "error" && <Problem error={detail.error} onRetry={detail.reload} />}
      {detail.status === "ready" && detail.data.students.map((s) => <EvidenceStudentCard key={s.studentId} student={s} code={row.code} />)}
    </section>
  );
};
