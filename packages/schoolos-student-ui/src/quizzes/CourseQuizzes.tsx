import { Badge, Link, Surface, Text } from "@cloudflare/kumo";
import { isNotFound, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import type { QuizView } from "../model.ts";
import { quizPath } from "../router.tsx";
import { AVAILABILITY_LABEL, formatPoints, quizFacts } from "./quizText.ts";

const AVAILABILITY_VARIANT = { upcoming: "neutral", open: "success", closed: "secondary" } as const satisfies Record<QuizView["availability"], string>;

/** A class's published quizzes: each with when it is open, what it asks, and the student's released score. A class with none shows nothing. */
export const CourseQuizzes = ({ offeringId }: { offeringId: string }) => {
  const [quizzes, reload] = useQuery(`quizzes:${offeringId}`, async (api) => {
    try {
      return await api.call("student.listQuizzes", { params: { offeringId } });
    } catch (error) {
      // A class the student has left answers not-found.
      if (isNotFound(error)) return [];
      throw error;
    }
  });
  if (quizzes.status === "loading") return null;
  if (quizzes.status === "error") return <ErrorState error={quizzes.error} title="We couldn't load this class's quizzes" onRetry={reload} />;
  if (quizzes.data.length === 0) return null;

  return (
    <section aria-labelledby="quizzes" className="flex flex-col gap-3">
      <Text variant="heading" as="h2">
        <span id="quizzes">Quizzes</span>
      </Text>
      <ul className="flex flex-col gap-3">
        {quizzes.data.map((quiz) => (
          <li key={quiz.id}>
            <Surface className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Text variant="heading" as="h3">
                  <Link href={quizPath(offeringId, quiz.id)} variant="plain">{quiz.title}</Link>
                </Text>
                <Badge variant={AVAILABILITY_VARIANT[quiz.availability]}>{AVAILABILITY_LABEL[quiz.availability]}</Badge>
                {quiz.attempts.some((a) => a.status === "in-progress") ? <Badge variant="info">In progress</Badge> : null}
              </div>
              <Text variant="secondary" size="sm">{quizFacts(quiz)}</Text>
              {quiz.availableUntil === undefined ? null : (
                <Text variant="secondary" size="sm">
                  {quiz.availability === "closed" ? "Closed " : "Closes "}<time dateTime={quiz.availableUntil}>{formatDateTime(quiz.availableUntil)}</time>
                </Text>
              )}
              {quiz.releasedScore === undefined ? null : (
                <Text size="sm">{`Your score: ${formatPoints(quiz.releasedScore.points)} out of ${formatPoints(quiz.releasedScore.maxPoints)}`}</Text>
              )}
            </Surface>
          </li>
        ))}
      </ul>
    </section>
  );
};
