import { useState } from "react";
import { Badge, Banner, Breadcrumbs, Button, Link, Text } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor, useApi, useQuery } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { formatDateTime } from "../labels.ts";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import type { QuizAttemptResult, QuizAttemptView, QuizView } from "../model.ts";
import { PageText } from "../modules/PageText.tsx";
import { coursePath, quizResultPath } from "../router.tsx";
import { AttemptResultView } from "./AttemptResultView.tsx";
import { QuizTaking } from "./QuizTaking.tsx";
import { useClassTitle } from "../useClassTitle.ts";
import { AVAILABILITY_LABEL, formatPoints, quizFacts } from "./quizText.ts";

const ATTEMPT_STATUS = { "in-progress": "In progress", submitted: "Submitted", expired: "Time ran out" } as const;

/** Where the page is: the quiz's overview, an attempt being taken, or the attempt just submitted. */
type Stage = { stage: "overview" } | { stage: "taking"; attempt: QuizAttemptView } | { stage: "submitted"; result: QuizAttemptResult };

/** A quiz before and between attempts: what it asks, the student's attempts, and starting or resuming one. */
const QuizOverview = ({ quiz, onStart, starting, startError }: { quiz: QuizView; onStart: () => void; starting: boolean; startError: unknown }) => {
  const live = quiz.attempts.find((a) => a.status === "in-progress");
  return (
    <div className="flex flex-col gap-4">
      {quiz.description.trim() === "" ? null : <PageText markdown={quiz.description} />}
      <Text variant="secondary">{quizFacts(quiz)}</Text>
      <Text variant="secondary" size="sm">
        {quiz.availableFrom === undefined ? null : <>Opens <time dateTime={quiz.availableFrom}>{formatDateTime(quiz.availableFrom)}</time>. </>}
        {quiz.availableUntil === undefined ? null : <>Closes <time dateTime={quiz.availableUntil}>{formatDateTime(quiz.availableUntil)}</time>.</>}
      </Text>
      {quiz.releasedScore === undefined ? null : (
        <Text>
          <span className="font-semibold">{`Your score: ${formatPoints(quiz.releasedScore.points)} out of ${formatPoints(quiz.releasedScore.maxPoints)}`}</span>
        </Text>
      )}
      {quiz.attempts.length === 0 ? null : (
        <section aria-labelledby="attempts" className="flex flex-col gap-2">
          <Text variant="heading" as="h2"><span id="attempts">Your attempts</span></Text>
          <ul className="flex flex-col gap-2">
            {quiz.attempts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                {a.status === "in-progress"
                  ? <Text>{`Attempt ${a.number}`}</Text>
                  : <Link href={quizResultPath(quiz.offeringId, quiz.id, a.id)}>{`Attempt ${a.number}`}</Link>}
                <Badge variant={a.status === "submitted" ? "success" : a.status === "expired" ? "warning" : "info"}>{ATTEMPT_STATUS[a.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      {startError === undefined ? null : (
        <div role="alert">
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="The quiz didn't start" description={messageFor(startError)} />
        </div>
      )}
      {quiz.canStart ? (
        <div>
          <Button variant="primary" loading={starting} disabled={starting} onClick={onStart}>
            {live === undefined ? (quiz.attempts.length === 0 ? "Start quiz" : `Start attempt ${quiz.attempts.length + 1}`) : `Resume attempt ${live.number}`}
          </Button>
        </div>
      ) : (
        <Text variant="secondary">
          {quiz.availability === "upcoming" ? "This quiz isn't open yet." : quiz.availability === "closed" ? "This quiz is closed." : "You've used every attempt this quiz allows."}
        </Text>
      )}
    </div>
  );
};

/** A quiz: its overview, taking an attempt, and the attempt's results once submitted. */
export const QuizPage = ({ offeringId, quizId }: { offeringId: string; quizId: string }) => {
  const api = useApi();
  const [quiz, reload] = useQuery(`quiz:${offeringId}:${quizId}`, (client) => client.call("student.getQuiz", { params: { offeringId, quizId } }));
  const classTitle = useClassTitle(offeringId, quiz.status === "ready" && quiz.data.courseTitle !== "" ? quiz.data.courseTitle : "Class");
  const [stage, setStage] = useState<Stage>({ stage: "overview" });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>();

  if (quiz.status === "loading") return <LoadingSkeleton label="Loading the quiz" lines={4} />;
  if (quiz.status === "error") return <ErrorState error={quiz.error} title="We couldn't open this quiz" onRetry={reload} />;

  const start = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      setStage({ stage: "taking", attempt: await api.call("student.startQuizAttempt", { params: { offeringId, quizId } }) });
    } catch (error) {
      setStartError(error);
      reload();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Home</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Link href={coursePath(offeringId)}>{classTitle}</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>{quiz.data.title}</Breadcrumbs.Current>
      </Breadcrumbs>
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="heading" size="lg" as="h1">{quiz.data.title}</Text>
        <Badge variant="neutral">{AVAILABILITY_LABEL[quiz.data.availability]}</Badge>
      </div>
      {stage.stage === "overview" ? <QuizOverview quiz={quiz.data} onStart={() => void start()} starting={starting} startError={startError} /> : null}
      {stage.stage === "taking" ? (
        <QuizTaking
          offeringId={offeringId}
          attempt={stage.attempt}
          timed={quiz.data.timeLimitMinutes !== undefined}
          onSubmitted={(result) => {
            setStage({ stage: "submitted", result });
            reload();
          }}
        />
      ) : null}
      {stage.stage === "submitted" ? (
        <section aria-labelledby="submitted" className="flex flex-col gap-3">
          <Text variant="heading" as="h2"><span id="submitted">{`Attempt ${stage.result.number} submitted`}</span></Text>
          <AttemptResultView result={stage.result} />
          <div>
            <Button onClick={() => setStage({ stage: "overview" })}>Back to the quiz</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
};
