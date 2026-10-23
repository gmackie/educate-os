import { useState } from "react";
import { Badge, Button, Input, InputArea, Text } from "@cloudflare/kumo";
import { FloppyDisk } from "@phosphor-icons/react";
import { Loading } from "../Loading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import type { QuizItem, StaffAttempt } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { formatPoints } from "./quizText.ts";

type Answer = StaffAttempt["attempt"]["answers"][number]["response"];
type Score = NonNullable<StaffAttempt["attempt"]["itemScores"]>[number];

/** A student's response in words: the chosen choices' text, true or false, the number or the text written. */
const responseText = (item: QuizItem, response: Answer | undefined): string => {
  if (response === undefined) return "No answer";
  const choice = (id: string) => (item.type === "multiple-choice" || item.type === "multiple-select" ? item.choices.find((c) => c.id === id)?.text ?? id : id);
  switch (response.type) {
    case "multiple-choice":
      return choice(response.choiceId);
    case "multiple-select":
      return response.choiceIds.length === 0 ? "None chosen" : response.choiceIds.map(choice).join("; ");
    case "true-false":
      return response.value ? "True" : "False";
    case "numeric":
      return String(response.value);
    default:
      return response.text === "" ? "No answer" : response.text;
  }
};

/** The answer key in words, for the teacher grading against it. */
const keyText = (item: QuizItem): string | undefined => {
  switch (item.type) {
    case "multiple-choice":
      return item.choices.find((c) => c.id === item.correctChoiceId)?.text;
    case "multiple-select":
      return item.choices.filter((c) => item.correctChoiceIds.includes(c.id)).map((c) => c.text).join("; ");
    case "true-false":
      return item.correct ? "True" : "False";
    case "numeric":
      return item.tolerance === 0 ? String(item.answer) : `${item.answer} (± ${item.tolerance})`;
    case "short-answer":
      return [...item.acceptedAnswers, ...(item.pattern === undefined ? [] : [`pattern ${item.pattern}`])].join("; ");
    case "essay":
      return undefined;
  }
};

/** Grading one item: its points and an optional comment to the student. */
const ItemGradeForm = ({ offeringId, attemptId, item, score, position, onGraded }: {
  offeringId: string;
  attemptId: string;
  item: QuizItem;
  score: Score;
  position: number;
  onGraded: () => void;
}) => {
  const [points, setPoints] = useState(score.points === null ? "" : String(score.points));
  const [comment, setComment] = useState(score.comment ?? "");
  const action = useAction(onGraded);
  const value = Number(points);
  const valid = points.trim() !== "" && value >= 0 && value <= score.maxPoints;
  return (
    <form
      aria-label={`Grade question ${position}`}
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run("grade", async (client) => {
          await client.call("teacher.gradeQuizItem", {
            params: { offeringId, attemptId, itemId: item.id },
            body: { points: value, ...(comment.trim() === "" ? {} : { comment }) },
          });
          return `Question ${position} graded ${formatPoints(value)} out of ${formatPoints(score.maxPoints)}.`;
        });
      }}
    >
      <Input label={`Points for question ${position} (out of ${formatPoints(score.maxPoints)})`} type="number" min={0} max={score.maxPoints} step="any" value={points}
        onChange={(event) => setPoints(event.target.value)} />
      <div className="min-w-64 grow">
        <InputArea label={`Comment on question ${position} (optional)`} value={comment} minRows={1} onValueChange={setComment} />
      </div>
      <Button type="submit" size="sm" variant="primary" icon={<FloppyDisk aria-hidden />} loading={action.running("grade")} disabled={!valid || action.busy}>
        Save grade
      </Button>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </form>
  );
};

/**
 * One student's submitted attempt as the teacher grades it: each question with the student's
 * answer, the key and how it scored. Essays wait for the teacher; any item may be rescored.
 */
export const AttemptGrader = ({ offeringId, attemptId, onGraded }: { offeringId: string; attemptId: string; onGraded: () => void }) => {
  const loaded = useLoad(`quiz-attempt:${attemptId}`, (client) => client.call("teacher.quizAttempt", { params: { offeringId, attemptId } }));
  if (loaded.status === "loading") return <Loading label="Opening the attempt…" />;
  if (loaded.status === "error") return <Problem error={loaded.error} onRetry={loaded.reload} />;
  const { quiz, attempt, studentName } = loaded.data;
  const responses = new Map(attempt.answers.map((a) => [a.itemId, a.response]));
  const scores = new Map((attempt.itemScores ?? []).map((s) => [s.itemId, s]));
  return (
    <section aria-label={`${studentName}, attempt ${attempt.number}`} className="flex flex-col gap-4 rounded-lg border border-kumo-hairline p-4">
      <h3><Text variant="heading" as="span">{`${studentName}, attempt ${attempt.number}`}</Text></h3>
      <ol className="flex flex-col gap-4">
        {quiz.items.map((item, index) => {
          const score = scores.get(item.id);
          const key = keyText(item);
          return (
            <li key={item.id} className="flex flex-col gap-2 border-t border-kumo-hairline pt-3">
              <Text as="p"><span className="whitespace-pre-line">{`${index + 1}. ${item.prompt}`}</span></Text>
              <Text as="p"><span className="whitespace-pre-line">{`Answer: ${responseText(item, responses.get(item.id))}`}</span></Text>
              {key !== undefined && <Text variant="secondary" size="sm" as="p">{`Key: ${key}`}</Text>}
              {score !== undefined && (
                <div className="flex flex-wrap items-center gap-2">
                  {score.points === null
                    ? <Badge variant="warning">Needs grading</Badge>
                    : <Badge variant={score.points >= score.maxPoints ? "success" : "neutral"}>{`${formatPoints(score.points)} / ${formatPoints(score.maxPoints)}`}</Badge>}
                  {score.source === "teacher" && <Text variant="secondary" size="sm" as="span">Graded by a teacher</Text>}
                </div>
              )}
              {score !== undefined && (
                <ItemGradeForm offeringId={offeringId} attemptId={attempt.id} item={item} score={score} position={index + 1} onGraded={() => {
                  loaded.reload();
                  onGraded();
                }} />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
