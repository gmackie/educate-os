import { Text } from "@cloudflare/kumo";
import type { RouteResponse } from "@educateos/api-client";

type Opportunity = RouteResponse<"teacher.planner">[number]["opportunities"][number];
/** Preserves historical judgments, evidence sources and append-only teacher corrections. */
export const PlannerJudgmentHistory = ({ reviews, criteria }: { reviews: Opportunity["reviews"]; criteria?: Opportunity["contract"]["criteria"] }) => {
  const latest = reviews.at(-1);
  return <>
    {latest?.decision === "recommend" && !latest.assessment?.rubric && <p role="status">Needs criterion-level reconfirmation. The historical teacher judgment is preserved; it is not newly verified evidence.</p>}
    <ol aria-label="Teacher judgment history">{reviews.map((r, index) => <li key={`${r.by}:${r.at}:${index}`}>
      <Text>{r.level} · {r.assistance} · {r.decision} · {r.rationale} · {r.at} · Reviewer: {r.by}</Text>
      {r.assessment && <><Text>Separate teacher check: {r.assessment.context} · {r.assessment.observedAt} · {r.assessment.method}</Text>
        {r.assessment.rubric ? <><Text>Rubric: {r.assessment.rubric.contractId} · version {r.assessment.rubric.contractVersion} · Source: teacher-observed common check</Text>
          <ul>{r.assessment.rubric.criteria.map((c) => <li key={c.criterionId}><Text>{criteria?.find((criterion) => criterion.id === c.criterionId)?.description ?? c.criterionId}: {c.rating}</Text><blockquote className="whitespace-pre-wrap">{c.sourceSnippet}</blockquote></li>)}</ul>
        </> : <Text>Historical review · no criterion-level evidence recorded</Text>}
      </>}
    </li>)}</ol>
  </>;
};
