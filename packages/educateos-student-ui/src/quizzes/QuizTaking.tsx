import { useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { HourglassMediumIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { DistrictApiError } from "@educateos/api-client";
import { messageFor, useApi } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import type { QuizAttemptResult, QuizAttemptView, QuizResponse } from "../model.ts";
import { QuestionField } from "./QuestionField.tsx";
import { formatClock, isAnswered } from "./quizText.ts";
import { useAutosave } from "./useAutosave.ts";
import { useQuizClock } from "./useQuizClock.ts";

const savedTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** Whether a call was refused because the attempt's time ran out. */
const isTimeUp = (error: unknown) => error instanceof DistrictApiError && error.code === "forbidden";

/**
 * An attempt in progress: its questions in this attempt's order, answers saved as the student
 * works, the time left on the district's clock, and submitting after the student confirms. Once
 * time is up the attempt can no longer be changed; the district refuses a late submission too.
 */
export const QuizTaking = ({ offeringId, attempt, onSubmitted }: {
  offeringId: string;
  attempt: QuizAttemptView;
  onSubmitted: (result: QuizAttemptResult) => void;
}) => {
  const api = useApi();
  const announce = useAnnounce();
  const params = { offeringId, attemptId: attempt.attemptId };
  const [answers, setAnswers] = useState(() => new Map(attempt.answers.map((a) => [a.itemId, a.response])));
  const [numberTexts, setNumberTexts] = useState(() => new Map(attempt.answers.flatMap((a) => (a.response.type === "numeric" ? [[a.itemId, String(a.response.value)] as const] : []))));
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<unknown>();
  const autosave = useAutosave((changed) => api.call("student.saveQuizAnswers", { params, body: { answers: changed } }));
  const clock = useQuizClock(attempt.deadline, attempt.serverNow);
  const timeUp = clock.timeUp || isTimeUp(refusal) || (autosave.state.status === "failed" && isTimeUp(autosave.state.error));
  const unanswered = attempt.questions.filter((q) => !isAnswered(answers.get(q.id))).length;

  const answer = (itemId: string, response: QuizResponse) => {
    setAnswers(new Map(answers).set(itemId, response));
    autosave.change(itemId, response);
  };

  const submit = async () => {
    setSubmitting(true);
    setRefusal(undefined);
    autosave.stop();
    try {
      const result = await api.call("student.submitQuizAttempt", {
        params,
        body: { answers: [...answers].map(([itemId, response]) => ({ itemId, response })) },
      });
      announce("Your quiz was submitted.");
      onSubmitted(result);
    } catch (error) {
      setRefusal(error);
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {clock.remaining === undefined ? (
          <Text variant="secondary">No time limit. Your answers are saved as you go.</Text>
        ) : (
          <Text>
            Time left: <span role="timer" aria-label="Time left" className="font-semibold tabular-nums">{formatClock(clock.remaining)}</span>
          </Text>
        )}
        <Text variant="secondary" size="sm">
          {autosave.state.status === "saving" ? "Saving…" : null}
          {autosave.state.status === "saved" ? `Saved at ${savedTime.format(new Date(autosave.state.at))}` : null}
          {autosave.state.status === "failed" && !timeUp ? "Not saved yet. We'll try again with your next change." : null}
        </Text>
      </div>
      {timeUp ? (
        <div role="alert">
          <Banner variant="error" icon={<HourglassMediumIcon weight="fill" />} title="Time is up"
            description="This attempt ended before it was submitted, so it can't be changed or submitted now. It counts as one of your attempts." />
        </div>
      ) : null}
      {refusal !== undefined && !timeUp ? (
        <div role="alert">
          <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="Not submitted" description={messageFor(refusal)} />
        </div>
      ) : null}
      <form
        aria-label={attempt.title}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
      >
        <ol className="flex flex-col gap-4">
          {attempt.questions.map((question, index) => (
            <li key={question.id}>
              <QuestionField
                question={question}
                number={index + 1}
                response={answers.get(question.id)}
                numberText={numberTexts.get(question.id) ?? ""}
                disabled={timeUp || submitting}
                onAnswer={(response) => answer(question.id, response)}
                onNumberText={(text) => setNumberTexts(new Map(numberTexts).set(question.id, text))}
                onLeave={autosave.flush}
              />
            </li>
          ))}
        </ol>
        {confirming ? (
          <div role="group" aria-label="Confirm submitting" className="flex flex-col gap-2 rounded-lg border border-kumo-hairline p-4">
            <Text>
              {unanswered === 0
                ? "You've answered every question. Submit now? You can't change your answers after."
                : `You have ${unanswered} unanswered question${unanswered === 1 ? "" : "s"}. Submit now? You can't change your answers after.`}
            </Text>
            <div className="flex gap-2">
              <Button variant="primary" loading={submitting} disabled={submitting || timeUp} onClick={() => void submit()}>Submit answers</Button>
              <Button disabled={submitting} onClick={() => setConfirming(false)}>Keep working</Button>
            </div>
          </div>
        ) : (
          <div>
            <Button type="submit" variant="primary" disabled={timeUp}>Submit quiz</Button>
          </div>
        )}
      </form>
    </div>
  );
};
