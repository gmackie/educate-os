import { useState } from "react";
import { Badge, Button, Empty, LayerCard, Table, Text } from "@cloudflare/kumo";
import { ChartBar, PaperPlaneTilt } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { useSteadyLoad } from "../useSteadyLoad.ts";
import { useAction } from "../modules/useAction.ts";
import { routeHref } from "../route.ts";
import { Loading } from "../Loading.tsx";
import type { QuizResults, ReleaseOutcome, TeachingOffering } from "../types.ts";
import { AttemptGrader } from "./AttemptGrader.tsx";
import { formatPoints } from "./quizText.ts";
import { formatDateTime } from "../dates.ts";

type Row = QuizResults["students"][number];

/** What a release did, in a sentence. */
const releaseSummary = (outcome: ReleaseOutcome): string => {
  const parts = [
    outcome.official > 0 ? `${outcome.official} score${outcome.official === 1 ? "" : "s"} released as official grades` : undefined,
    outcome.pendingApproval > 0 ? `${outcome.pendingApproval} waiting for the class's teacher to approve` : undefined,
    outcome.unchanged > 0 ? `${outcome.unchanged} already released` : undefined,
    outcome.waitingForGrading > 0 ? `${outcome.waitingForGrading} still need essays graded` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "There were no scores to release." : `${parts.join(", ")}.`;
};

/** Where a student's score stands. */
const ScoreStatus = ({ row }: { row: Row }) => {
  if (row.needsGrading) return <Badge variant="warning">Needs grading</Badge>;
  if (row.score === undefined) return <Text variant="secondary" as="span">No submission</Text>;
  const score = `${formatPoints(row.score.points)} / ${formatPoints(row.score.maxPoints)}`;
  if (row.released?.current === true) return <span className="flex flex-wrap gap-2"><span>{score}</span><Badge variant="success">Released</Badge></span>;
  if (row.released?.outcome === "pending-approval") return <span className="flex flex-wrap gap-2"><span>{score}</span><Badge variant="info">Waiting for approval</Badge></span>;
  return <span className="flex flex-wrap gap-2"><span>{score}</span><Badge variant="neutral">{row.released === undefined ? "Not released" : "Changed since release"}</Badge></span>;
};

/** Why there is nothing to release, in the quiz's own terms. */
const nothingToRelease = (data: QuizResults): string => {
  if (data.quiz.status === "draft") return "Publish the quiz first. Scores can be released once students have taken it and they're graded.";
  if (data.students.length === 0) return "No one has taken the quiz yet, so there are no scores to release.";
  if (data.students.some((row) => row.needsGrading)) return "Scores can be released once their essays are graded.";
  if (data.releases.length > 0) return "Every graded score is already released.";
  return "No scores are ready to release yet.";
};

/** Releasing every fully graded score as an official grade, after the teacher confirms. */
const ReleaseControl = ({ offeringId, quizId, releasable, idleHint, onReleased }: {
  offeringId: string;
  quizId: string;
  releasable: number;
  /** Why nothing can be released, shown when nothing can. */
  idleHint: string;
  onReleased: () => void;
}) => {
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ReleaseOutcome>();
  const action = useAction(onReleased);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {confirming
          ? (
            <>
              <Text as="span">{`Release ${releasable} score${releasable === 1 ? "" : "s"} as official grades? Students and the gradebook will see them.`}</Text>
              <Button variant="primary" loading={action.running("release")} disabled={action.busy}
                onClick={() => void action.run("release", async (client) => {
                  const result = await client.call("teacher.releaseQuizScores", { params: { offeringId, quizId }, body: {} });
                  setOutcome(result);
                  setConfirming(false);
                  return releaseSummary(result);
                })}>
                Release now
              </Button>
              <Button onClick={() => setConfirming(false)}>Not yet</Button>
            </>
          )
          : (
            <Button variant="primary" icon={<PaperPlaneTilt aria-hidden />} disabled={releasable === 0} onClick={() => setConfirming(true)}>
              Release scores
            </Button>
          )}
        {!confirming && releasable === 0 && <Text variant="secondary" size="sm" as="span">{idleHint}</Text>}
      </div>
      {outcome !== undefined && <Text as="p">{releaseSummary(outcome)}</Text>}
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </div>
  );
};

/**
 * A quiz's results: each student's attempts and where their score stands, how each question fared,
 * grading essays (or rescoring any item), and releasing scores as official grades in one action.
 */
export const QuizResultsPage = ({ teaching, quizId }: { teaching: TeachingOffering; quizId: string }) => {
  const offeringId = teaching.offering.id;
  const [grading, setGrading] = useState<string>();
  const results = useSteadyLoad(`quiz-results:${offeringId}:${quizId}`, (client) => client.call("teacher.quizResults", { params: { offeringId, quizId } }));
  const data = results.data;
  const names = new Map((data?.names ?? []).map((n) => [n.principalId, n.displayName]));

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Quiz">
        <a href={routeHref({ screen: "quizzes", offeringId })}>All quizzes</a>
      </nav>
      {results.error !== undefined && <Problem error={results.error} onRetry={results.reload} />}
      {data === undefined && results.error === undefined && <Loading label="Loading the results…" />}
      {data !== undefined && (
        <>
          <PageHeading>{`Results: ${data.quiz.title} · ${classLabel(teaching)}`}</PageHeading>
          <a href={routeHref({ screen: "quiz", offeringId, quizId })}>Edit quiz</a>
          <ReleaseControl offeringId={offeringId} quizId={quizId} releasable={data.releasable} idleHint={nothingToRelease(data)} onReleased={results.reload} />
          {data.students.length === 0
            ? <Empty icon={<ChartBar size={32} aria-hidden />} title="No attempts yet" description="Results appear here once students start the quiz." />
            : (
              <LayerCard className="overflow-x-auto p-0">
                <Table>
                  <caption className="sr-only">Students' results</caption>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Student</Table.Head>
                      <Table.Head>Attempts</Table.Head>
                      <Table.Head>Score</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {data.students.map((row) => {
                      const name = names.get(row.studentId) ?? "A student";
                      return (
                        <Table.Row key={row.studentId}>
                          <Table.Cell>{name}</Table.Cell>
                          <Table.Cell>
                            <ul className="flex flex-col gap-1">
                              {row.attempts.map((a) => (
                                <li key={a.id} className="flex flex-wrap items-center gap-2">
                                  <span>{`Attempt ${a.number}: ${a.status === "submitted"
                                    ? (a.points === null || a.points === undefined ? "needs grading" : `${formatPoints(a.points)} / ${formatPoints(a.maxPoints)}`)
                                    : a.status === "expired" ? "time ran out" : "in progress"}`}</span>
                                  {a.status === "submitted" && (
                                    <Button size="sm" variant={grading === a.id ? "primary" : "secondary"} aria-pressed={grading === a.id}
                                      onClick={() => setGrading(grading === a.id ? undefined : a.id)}>
                                      {`Grade ${name}, attempt ${a.number}`}
                                    </Button>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </Table.Cell>
                          <Table.Cell><ScoreStatus row={row} /></Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table>
              </LayerCard>
            )}
          {grading !== undefined && <AttemptGrader key={grading} offeringId={offeringId} attemptId={grading} onGraded={results.reload} />}
          <section aria-labelledby="item-analysis" className="flex flex-col gap-2">
            <h2 id="item-analysis"><Text variant="heading" as="span">How each question went</Text></h2>
            <LayerCard className="overflow-x-auto p-0">
              <Table>
                <caption className="sr-only">Item analysis</caption>
                <Table.Header>
                  <Table.Row>
                    <Table.Head>Question</Table.Head>
                    <Table.Head>Answered</Table.Head>
                    <Table.Head>Correct</Table.Head>
                    <Table.Head>Average points</Table.Head>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {data.items.map((analysis, index) => {
                    const item = data.quiz.items.find((i) => i.id === analysis.itemId);
                    return (
                      <Table.Row key={analysis.itemId}>
                        <Table.Cell>{`${index + 1}. ${item?.prompt.split("\n")[0] ?? ""}`}</Table.Cell>
                        <Table.Cell>{analysis.responses}</Table.Cell>
                        <Table.Cell>{analysis.percentCorrect === null ? "Not graded yet" : `${analysis.percentCorrect}%`}</Table.Cell>
                        <Table.Cell>{analysis.meanPoints === null ? "—" : formatPoints(analysis.meanPoints)}</Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table>
            </LayerCard>
          </section>
          {data.releases.length > 0 && (
            <Text variant="secondary" size="sm" as="p">{`Last released ${formatDateTime(data.releases.at(-1)!.at)}.`}</Text>
          )}
        </>
      )}
    </div>
  );
};
