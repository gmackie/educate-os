import { Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import type { QuizQuestion, QuizResponse } from "../model.ts";
import { ReadAloudButton } from "../readAloud/ReadAloudButton.tsx";
import { SpokenText } from "../readAloud/SpokenText.tsx";
import { useReadAloud } from "../readAloud/useReadAloud.ts";
import { pointsLabel } from "./quizText.ts";

/** How a question is shown: `young` gives large type and choice cards; `readAloud` a "Read to me". */
export interface QuestionPresentation {
  young: boolean;
  readAloud: boolean;
}

/** What "Read to me" says for a question: the question, then its choices. */
export const spokenQuestion = (question: QuizQuestion): string => {
  const choices = question.type === "true-false" ? ["True", "False"] : (question.choices ?? []).map((choice) => choice.text);
  return choices.length === 0 ? question.prompt : `${question.prompt}\n${choices.join(".\n")}.`;
};

/** The question's prompt with its "Read to me", for classes that read aloud. */
const ReadAloudQuestion = ({ question, number, young }: { question: QuizQuestion; number: number; young: boolean }) => {
  const control = useReadAloud(spokenQuestion(question), `question ${number}`);
  if (!control.available) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      {/* The legend already names the question for assistive technology; this is the visual follow-along. */}
      {control.reading ? <div aria-hidden><SpokenText control={control} className={young ? "text-xl" : undefined} /></div> : null}
      <ReadAloudButton control={control} prominent={young} />
    </div>
  );
};

/**
 * One question as a student answers it: a fieldset whose legend is the question and its points,
 * holding the control its type needs. A number is kept as typed and sent once it reads as one.
 */
export const QuestionField = ({ question, number, presentation = { young: false, readAloud: false }, response, numberText, disabled, onAnswer, onNumberText, onLeave }: {
  question: QuizQuestion;
  number: number;
  presentation?: QuestionPresentation;
  response: QuizResponse | undefined;
  /** What is typed in a number question, which may not read as a number yet. */
  numberText: string;
  disabled: boolean;
  onAnswer: (response: QuizResponse) => void;
  onNumberText: (text: string) => void;
  /** Focus left the question: a good moment to save. */
  onLeave: () => void;
}) => {
  const legend = `Question ${number} (${pointsLabel(question.points)}): ${question.prompt}`;
  const { young } = presentation;
  const appearance = young ? "card" : undefined;
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave();
      }}
    >
      <legend className="px-1">
        {young
          ? <span className="whitespace-pre-line text-2xl font-semibold">{legend}</span>
          : <Text variant="heading" as="span"><span className="whitespace-pre-line">{legend}</span></Text>}
      </legend>
      {presentation.readAloud ? <ReadAloudQuestion question={question} number={number} young={young} /> : null}
      {question.type === "multiple-choice" ? (
        <Radio.Group legend="Choose one" appearance={appearance} className={young ? "text-xl" : undefined} value={response?.type === "multiple-choice" ? response.choiceId : ""}
          onValueChange={(value) => onAnswer({ type: "multiple-choice", choiceId: value as string })}>
          {(question.choices ?? []).map((choice) => <Radio.Item key={choice.id} value={choice.id} label={choice.text} />)}
        </Radio.Group>
      ) : null}
      {question.type === "true-false" ? (
        <Radio.Group legend="True or false" appearance={appearance} className={young ? "text-xl" : undefined} value={response?.type === "true-false" ? String(response.value) : ""}
          onValueChange={(value) => onAnswer({ type: "true-false", value: value === "true" })}>
          <Radio.Item value="true" label="True" />
          <Radio.Item value="false" label="False" />
        </Radio.Group>
      ) : null}
      {question.type === "multiple-select" ? (
        <Checkbox.Group legend="Choose all that apply" value={response?.type === "multiple-select" ? response.choiceIds : []}
          onValueChange={(choiceIds) => onAnswer({ type: "multiple-select", choiceIds })}>
          {(question.choices ?? []).map((choice) => <Checkbox.Item key={choice.id} value={choice.id} label={choice.text} />)}
        </Checkbox.Group>
      ) : null}
      {question.type === "numeric" ? (
        <Input label="Your answer (a number)" type="number" inputMode="decimal" step="any" value={numberText}
          onChange={(event) => {
            onNumberText(event.target.value);
            const value = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value);
            if (Number.isFinite(value)) onAnswer({ type: "numeric", value });
          }} />
      ) : null}
      {question.type === "short-answer" ? (
        <Input label="Your answer" maxLength={question.maxLength} value={response?.type === "short-answer" ? response.text : ""}
          onChange={(event) => onAnswer({ type: "short-answer", text: event.target.value })} />
      ) : null}
      {question.type === "essay" ? (
        <InputArea label="Your answer" autoResize minRows={4} maxRows={16} maxLength={question.maxLength}
          value={response?.type === "essay" ? response.text : ""}
          onValueChange={(text) => onAnswer({ type: "essay", text })} />
      ) : null}
    </fieldset>
  );
};
