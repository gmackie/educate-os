import { Button, Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import { ArrowDown, ArrowUp, Plus, Trash } from "@phosphor-icons/react";
import type { QuizItemDraft } from "../types.ts";
import { ITEM_TYPE_LABEL } from "./quizText.ts";

type ChoiceItem = Extract<QuizItemDraft, { type: "multiple-choice" | "multiple-select" }>;

/** A new item of `type`, ready for the teacher to fill in. */
export const blankItem = (type: QuizItemDraft["type"]): QuizItemDraft => {
  const base = { prompt: "", points: 1 };
  const choices = [{ id: "c1", text: "" }, { id: "c2", text: "" }];
  switch (type) {
    case "multiple-choice":
      return { ...base, type, choices, correctChoiceId: "c1" };
    case "multiple-select":
      return { ...base, type, choices, correctChoiceIds: ["c1"], scoring: "all-or-nothing" };
    case "true-false":
      return { ...base, type, correct: true };
    case "numeric":
      return { ...base, type, answer: 0, tolerance: 0 };
    case "short-answer":
      return { ...base, type, acceptedAnswers: [] };
    case "essay":
      return { ...base, type, points: 5 };
  }
};

/** A number from an input, or undefined while what is typed is not one. */
const numberFrom = (text: string): number | undefined => (text.trim() === "" || Number.isNaN(Number(text)) ? undefined : Number(text));

/** A choice's name in the key pickers: its text, or its place while it has none. */
const choiceLabel = (index: number, text: string) => (text.trim() === "" ? `Choice ${index + 1}` : text);

/** The choices of a choice item, and which are correct. */
const ChoicesEditor = ({ item, label, onChange }: { item: ChoiceItem; label: string; onChange: (item: QuizItemDraft) => void }) => {
  const nextId = () => `c${Math.max(0, ...item.choices.map((c) => Number(c.id.slice(1)) || 0)) + 1}`;
  const setChoices = (choices: ChoiceItem["choices"]) => {
    if (item.type === "multiple-choice") {
      onChange({ ...item, choices, correctChoiceId: choices.some((c) => c.id === item.correctChoiceId) ? item.correctChoiceId : choices[0]!.id });
    } else {
      const kept = item.correctChoiceIds.filter((id) => choices.some((c) => c.id === id));
      onChange({ ...item, choices, correctChoiceIds: kept.length > 0 ? kept : [choices[0]!.id] });
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {item.choices.map((choice, index) => (
          <li key={choice.id} className="flex items-end gap-2">
            <div className="grow">
              <Input
                label={`${label}, choice ${index + 1}`}
                value={choice.text}
                maxLength={1000}
                onChange={(event) => setChoices(item.choices.map((c) => (c.id === choice.id ? { ...c, text: event.target.value } : c)))}
              />
            </div>
            <Button size="sm" variant="ghost" icon={<Trash aria-hidden />} aria-label={`Remove choice ${index + 1} from ${label}`} disabled={item.choices.length <= 2}
              onClick={() => setChoices(item.choices.filter((c) => c.id !== choice.id))} />
          </li>
        ))}
      </ol>
      <div>
        <Button size="sm" icon={<Plus aria-hidden />} disabled={item.choices.length >= 20} onClick={() => setChoices([...item.choices, { id: nextId(), text: "" }])}>
          Add a choice
        </Button>
      </div>
      {item.type === "multiple-choice"
        ? (
          <Radio.Group legend={`Correct answer to ${label}`} value={item.correctChoiceId} onValueChange={(value) => onChange({ ...item, correctChoiceId: value as string })}>
            {item.choices.map((c, i) => <Radio.Item key={c.id} value={c.id} label={choiceLabel(i, c.text)} />)}
          </Radio.Group>
        )
        : (
          <>
            <Checkbox.Group legend={`Correct answers to ${label}`} value={item.correctChoiceIds} onValueChange={(value) => value.length > 0 && onChange({ ...item, correctChoiceIds: value })}>
              {item.choices.map((c, i) => <Checkbox.Item key={c.id} value={c.id} label={choiceLabel(i, c.text)} />)}
            </Checkbox.Group>
            <Radio.Group legend={`Scoring for ${label}`} value={item.scoring} onValueChange={(value) => onChange({ ...item, scoring: value === "partial" ? "partial" : "all-or-nothing" })}>
              <Radio.Item value="all-or-nothing" label="All or nothing: full points only for exactly the correct choices" />
              <Radio.Item value="partial" label="Partial credit: a share for each correct choice, less one for each wrong one" />
            </Radio.Group>
          </>
        )}
    </div>
  );
};

/**
 * One item of a quiz as the teacher builds it: its prompt, points and answer key, by type, and its
 * place in the quiz. Numbers are typed freely and taken once they read as numbers.
 */
export const ItemEditor = ({ item, position, count, locked, onChange, onMove, onRemove }: {
  item: QuizItemDraft;
  /** 1-based. */
  position: number;
  count: number;
  /** Whether students have started the quiz, so its questions can no longer change. */
  locked: boolean;
  onChange: (item: QuizItemDraft) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) => {
  const label = `Question ${position}`;
  return (
    <fieldset disabled={locked} className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <legend className="px-1"><Text variant="heading" as="span">{`${label}: ${ITEM_TYPE_LABEL[item.type]}`}</Text></legend>
      <InputArea label={`${label} prompt`} value={item.prompt} autoResize minRows={2} onValueChange={(prompt) => onChange({ ...item, prompt })} />
      <Input label={`${label} points`} type="number" min={0} step="any" defaultValue={String(item.points)}
        onChange={(event) => {
          const points = numberFrom(event.target.value);
          if (points !== undefined && points > 0) onChange({ ...item, points });
        }} />
      {(item.type === "multiple-choice" || item.type === "multiple-select") && <ChoicesEditor item={item} label={label} onChange={onChange} />}
      {item.type === "true-false" && (
        <Radio.Group legend={`Correct answer to ${label}`} value={item.correct ? "true" : "false"} onValueChange={(value) => onChange({ ...item, correct: value === "true" })}>
          <Radio.Item value="true" label="True" />
          <Radio.Item value="false" label="False" />
        </Radio.Group>
      )}
      {item.type === "numeric" && (
        <div className="flex flex-wrap gap-3">
          <Input label={`${label} answer`} type="number" step="any" defaultValue={String(item.answer)}
            onChange={(event) => {
              const answer = numberFrom(event.target.value);
              if (answer !== undefined) onChange({ ...item, answer });
            }} />
          <Input label={`${label} tolerance (plus or minus)`} type="number" min={0} step="any" defaultValue={String(item.tolerance)}
            onChange={(event) => {
              const tolerance = numberFrom(event.target.value);
              if (tolerance !== undefined && tolerance >= 0) onChange({ ...item, tolerance });
            }} />
        </div>
      )}
      {item.type === "short-answer" && (
        <>
          <InputArea
            label={`${label} accepted answers`}
            description="One per line. Capital letters and extra spaces don't matter."
            defaultValue={item.acceptedAnswers.join("\n")}
            minRows={2}
            onValueChange={(text) => onChange({ ...item, acceptedAnswers: text.split("\n").map((line) => line.trim()).filter((line) => line !== "") })}
          />
          <Input
            label={`${label} pattern (optional)`}
            description="A regular expression the whole answer must match, such as colou?r. Patterns that could run slowly are refused."
            maxLength={200}
            value={item.pattern ?? ""}
            onChange={(event) => {
              const { pattern: _previous, ...rest } = item;
              onChange(event.target.value === "" ? rest : { ...rest, pattern: event.target.value });
            }}
          />
        </>
      )}
      {item.type === "essay" && (
        <Input label={`${label} longest answer, in characters (optional)`} type="number" min={1} max={20000} defaultValue={item.maxLength === undefined ? "" : String(item.maxLength)}
          onChange={(event) => {
            const { maxLength: _previous, ...rest } = item;
            const maxLength = numberFrom(event.target.value);
            onChange(maxLength === undefined ? rest : { ...rest, maxLength: Math.round(maxLength) });
          }} />
      )}
      <InputArea
        label={`${label} feedback (optional)`}
        description="Shown with the correct answer, when the quiz shows answers."
        value={item.feedback ?? ""}
        minRows={1}
        onValueChange={(text) => {
          const { feedback: _previous, ...rest } = item;
          onChange(text === "" ? rest : { ...rest, feedback: text });
        }}
      />
      <div role="group" aria-label={`Arrange ${label}`} className="flex flex-wrap gap-2">
        <Button size="sm" icon={<ArrowUp aria-hidden />} disabled={position === 1} onClick={() => onMove(-1)}>Move up</Button>
        <Button size="sm" icon={<ArrowDown aria-hidden />} disabled={position === count} onClick={() => onMove(1)}>Move down</Button>
        <Button size="sm" variant="ghost" icon={<Trash aria-hidden />} onClick={onRemove}>{`Remove ${label}`}</Button>
      </div>
    </fieldset>
  );
};
