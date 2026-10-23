import { Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import type { QuizQuestion, QuizResponse } from "../model.ts";
import { pointsLabel } from "./quizText.ts";

/**
 * One question as a student answers it: a fieldset whose legend is the question and its points,
 * holding the control its type needs. A number is kept as typed and sent once it reads as one.
 */
export const QuestionField = ({ question, number, response, numberText, disabled, onAnswer, onNumberText, onLeave }: {
  question: QuizQuestion;
  number: number;
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
  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onLeave();
      }}
    >
      <legend className="px-1">
        <Text variant="heading" as="span"><span className="whitespace-pre-line">{legend}</span></Text>
      </legend>
      {question.type === "multiple-choice" ? (
        <Radio.Group legend="Choose one" value={response?.type === "multiple-choice" ? response.choiceId : ""}
          onValueChange={(value) => onAnswer({ type: "multiple-choice", choiceId: value as string })}>
          {(question.choices ?? []).map((choice) => <Radio.Item key={choice.id} value={choice.id} label={choice.text} />)}
        </Radio.Group>
      ) : null}
      {question.type === "true-false" ? (
        <Radio.Group legend="True or false" value={response?.type === "true-false" ? String(response.value) : ""}
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
