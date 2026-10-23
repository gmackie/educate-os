import { Badge, Banner, Surface, Text } from "@cloudflare/kumo";
import { InfoIcon } from "@phosphor-icons/react";
import { formatDateTime } from "../labels.ts";
import type { QuizAttemptResult } from "../model.ts";
import { formatPoints, pointsLabel, responseText } from "./quizText.ts";

type ItemResult = QuizAttemptResult["items"][number];

/** How one question went, as far as the quiz shows it. */
const ItemOutcome = ({ item, number, shown }: { item: ItemResult; number: number; shown: boolean }) => {
  const { question } = item;
  return (
    <Surface as="article" aria-label={`Question ${number}`} className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
      <Text variant="heading" as="h3">
        <span className="whitespace-pre-line">{`Question ${number} (${pointsLabel(question.points)}): ${question.prompt}`}</span>
      </Text>
      <Text><span className="whitespace-pre-line">{`Your answer: ${responseText(question, item.response)}`}</span></Text>
      {shown ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {item.points === null || item.points === undefined
              ? <Badge variant="neutral">Waiting for your teacher</Badge>
              : <Badge variant={item.correct === true ? "success" : "warning"}>{item.correct === true ? "Correct" : "Not fully correct"}</Badge>}
            {item.points === null || item.points === undefined ? null : (
              <Text variant="secondary" size="sm">{`${formatPoints(item.points)} of ${pointsLabel(question.points)}`}</Text>
            )}
          </div>
          {item.correctResponse === undefined ? null : <Text>{`Correct answer: ${responseText(question, item.correctResponse)}`}</Text>}
          {item.acceptedAnswers === undefined ? null : <Text variant="secondary" size="sm">{`Also accepted: ${item.acceptedAnswers.join("; ")}`}</Text>}
          {item.feedback === undefined ? null : <Text><span className="whitespace-pre-line">{item.feedback}</span></Text>}
          {item.comment === undefined ? null : <Text><span className="whitespace-pre-line">{`Your teacher: ${item.comment}`}</span></Text>}
        </>
      ) : null}
    </Surface>
  );
};

/**
 * A finished attempt as its student sees it: their answers always; the key, points and feedback
 * only when the quiz shows them; and their score once the teacher has released it.
 */
export const AttemptResultView = ({ result }: { result: QuizAttemptResult }) => (
  <div className="flex flex-col gap-4">
    <Text variant="secondary">
      {result.status === "expired"
        ? "Time ran out before this attempt was submitted."
        : result.submittedAt === undefined ? "Submitted." : <>Submitted <time dateTime={result.submittedAt}>{formatDateTime(result.submittedAt)}</time>.</>}
    </Text>
    {result.releasedScore === undefined ? (
      <Banner variant="secondary" icon={<InfoIcon weight="fill" />} title="Your score isn't released yet"
        description="Your teacher checks the quiz, grades any written answers, and then releases scores. You'll see yours here." />
    ) : (
      <Text variant="heading" as="p">{`Your score: ${formatPoints(result.releasedScore.points)} out of ${formatPoints(result.releasedScore.maxPoints)}`}</Text>
    )}
    {result.answersShown ? null : (
      <Text variant="secondary" size="sm">
        {result.released ? "This quiz doesn't show the correct answers." : "Correct answers aren't shown for this quiz yet."}
      </Text>
    )}
    <ol aria-label="Your answers" className="flex flex-col gap-3">
      {result.items.map((item, index) => (
        <li key={item.question.id}>
          <ItemOutcome item={item} number={index + 1} shown={result.answersShown} />
        </li>
      ))}
    </ol>
  </div>
);
