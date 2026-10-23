import { useState } from "react";
import { Badge, Banner, Button, Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import { Eye, EyeSlash, FloppyDisk, Info, Plus, Trash } from "@phosphor-icons/react";
import { classLabel } from "../classes/classLabel.ts";
import { Loading } from "../Loading.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { Problem } from "../Problem.tsx";
import { useAction } from "../modules/useAction.ts";
import { navigate, routeHref } from "../route.ts";
import type { Assignment, CourseModule, Quiz, QuizItemDraft, QuizSettings, TeachingOffering } from "../types.ts";
import { useLoad } from "../useLoad.ts";
import { blankItem, ItemEditor } from "./ItemEditor.tsx";
import { fromLocalInput, ITEM_TYPE_LABEL, toLocalInput } from "./quizText.ts";

const NONE = "none";
const ITEM_TYPES = Object.keys(ITEM_TYPE_LABEL) as QuizItemDraft["type"][];

type KeyedItem = { key: string; item: QuizItemDraft };

/** A setting that is either a value or absent, such as the time limit or the window's ends. */
const optional = <K extends keyof QuizSettings>(settings: QuizSettings, key: K, value: QuizSettings[K] | undefined): QuizSettings => {
  const { [key]: _previous, ...rest } = settings;
  return (value === undefined ? rest : { ...rest, [key]: value }) as QuizSettings;
};

/** The quiz's settings: attempts, time, window, order, when answers show and which attempt counts. */
const SettingsFields = ({ settings, onChange }: { settings: QuizSettings; onChange: (settings: QuizSettings) => void }) => (
  <fieldset className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
    <legend className="px-1"><Text variant="heading" as="span">Settings</Text></legend>
    <div className="flex flex-wrap gap-3">
      <Input label="Attempts allowed" type="number" min={1} max={20} defaultValue={String(settings.attemptsAllowed)}
        onChange={(event) => {
          const value = Math.round(Number(event.target.value));
          if (value >= 1 && value <= 20) onChange({ ...settings, attemptsAllowed: value });
        }} />
      <Input label="Time limit in minutes (optional)" type="number" min={1} max={600} defaultValue={settings.timeLimitMinutes === undefined ? "" : String(settings.timeLimitMinutes)}
        onChange={(event) => {
          const value = Math.round(Number(event.target.value));
          onChange(optional(settings, "timeLimitMinutes", event.target.value === "" || !(value >= 1 && value <= 600) ? undefined : value));
        }} />
    </div>
    <div className="flex flex-wrap gap-3">
      <Input label="Opens (optional)" type="datetime-local" defaultValue={toLocalInput(settings.availableFrom)}
        onChange={(event) => onChange(optional(settings, "availableFrom", fromLocalInput(event.target.value)))} />
      <Input label="Closes (optional)" type="datetime-local" defaultValue={toLocalInput(settings.availableUntil)}
        onChange={(event) => onChange(optional(settings, "availableUntil", fromLocalInput(event.target.value)))} />
    </div>
    <Checkbox label="Show each student the questions in their own order" checked={settings.shuffleQuestions} onCheckedChange={(on) => onChange({ ...settings, shuffleQuestions: on === true })} />
    <Checkbox label="Show each student the choices in their own order" checked={settings.shuffleChoices} onCheckedChange={(on) => onChange({ ...settings, shuffleChoices: on === true })} />
    <Radio.Group legend="Show students the correct answers and feedback" value={settings.showAnswers}
      onValueChange={(value) => onChange({ ...settings, showAnswers: value as QuizSettings["showAnswers"] })}>
      <Radio.Item value="after-release" label="After you release scores" />
      <Radio.Item value="after-submit" label="As soon as they submit" />
      <Radio.Item value="never" label="Never" />
    </Radio.Group>
    <Radio.Group legend="Which attempt counts" value={settings.scorePolicy}
      onValueChange={(value) => onChange({ ...settings, scorePolicy: value as QuizSettings["scorePolicy"] })}>
      <Radio.Item value="best" label="Their best attempt" />
      <Radio.Item value="latest" label="Their latest attempt" />
    </Radio.Group>
  </fieldset>
);

/** The quiz's details, settings and questions as the teacher edits them, saved together. */
const QuizForm = ({ quiz, assignments, modules, started, onSaved }: {
  quiz: Quiz;
  assignments: readonly Assignment[];
  modules: readonly CourseModule[];
  started: boolean;
  onSaved: () => void;
}) => {
  const [title, setTitle] = useState(quiz.title);
  const [description, setDescription] = useState(quiz.description);
  const [assignmentId, setAssignmentId] = useState(quiz.assignmentId ?? NONE);
  const [moduleId, setModuleId] = useState(quiz.moduleId ?? NONE);
  const [settings, setSettings] = useState(quiz.settings);
  const [items, setItems] = useState<KeyedItem[]>(quiz.items.map((item) => ({ key: item.id, item })));
  const [newKey, setNewKey] = useState(0);
  const action = useAction(onSaved);
  const params = { offeringId: quiz.offeringId, quizId: quiz.id };

  const replace = (key: string, item: QuizItemDraft) => setItems(items.map((entry) => (entry.key === key ? { key, item } : entry)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...items];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    setItems(next);
  };
  const add = (type: QuizItemDraft["type"]) => {
    setItems([...items, { key: `new-${newKey}`, item: blankItem(type) }]);
    setNewKey(newKey + 1);
  };

  return (
    <form
      aria-label="Quiz details"
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void action.run("save", async (client) => {
          const drafts = items.map((entry) => entry.item);
          // Questions are sent only when they changed: once students have started, the district refuses any change to them.
          const itemsChanged = JSON.stringify(drafts) !== JSON.stringify(quiz.items);
          const saved = await client.call("teacher.updateQuiz", {
            params,
            body: {
              title: title.trim(),
              description,
              settings,
              assignmentId: assignmentId === NONE ? null : assignmentId,
              moduleId: moduleId === NONE ? null : moduleId,
              ...(itemsChanged ? { items: drafts } : {}),
            },
          });
          return `Saved ${saved.title}.`;
        });
      }}
    >
      <Input label="Title" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea label="Instructions (optional)" value={description} autoResize minRows={2} onValueChange={setDescription} />
      <Radio.Group legend="Release scores as grades for" description="A quiz needs an assignment before it can be published; its released scores become that assignment's grades."
        value={assignmentId} onValueChange={(value) => setAssignmentId(value as string)}>
        <Radio.Item value={NONE} label="No assignment yet" />
        {assignments.map((a) => <Radio.Item key={a.id} value={a.id} label={a.title} />)}
      </Radio.Group>
      {modules.length > 0 && (
        <Radio.Group legend="Place it in a module" value={moduleId} onValueChange={(value) => setModuleId(value as string)}>
          <Radio.Item value={NONE} label="No module" />
          {modules.map((m) => <Radio.Item key={m.id} value={m.id} label={m.published ? m.title : `${m.title} (draft)`} />)}
        </Radio.Group>
      )}
      <SettingsFields settings={settings} onChange={setSettings} />
      <section aria-labelledby="quiz-questions" className="flex flex-col gap-3">
        <h2 id="quiz-questions"><Text variant="heading" as="span">Questions</Text></h2>
        {started && (
          <Banner variant="secondary" icon={<Info aria-hidden />} title="Students have started this quiz"
            description="Its questions can no longer change, so every attempt is scored against the same key. Settings can still change." />
        )}
        {items.length === 0 && <Text variant="secondary">No questions yet. Add one below.</Text>}
        {items.map((entry, index) => (
          <ItemEditor
            key={entry.key}
            item={entry.item}
            position={index + 1}
            count={items.length}
            locked={started}
            onChange={(item) => replace(entry.key, item)}
            onMove={(by) => move(index, by)}
            onRemove={() => setItems(items.filter((other) => other.key !== entry.key))}
          />
        ))}
        {!started && (
          <div role="group" aria-label="Add a question" className="flex flex-wrap gap-2">
            {ITEM_TYPES.map((type) => (
              <Button key={type} size="sm" icon={<Plus aria-hidden />} onClick={() => add(type)}>{`Add ${ITEM_TYPE_LABEL[type].toLowerCase()}`}</Button>
            ))}
          </div>
        )}
      </section>
      <div>
        <Button type="submit" variant="primary" icon={<FloppyDisk aria-hidden />} loading={action.running("save")} disabled={title.trim() === "" || action.busy}>
          Save quiz
        </Button>
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </form>
  );
};

/** Publishing, taking back and deleting a quiz. */
const QuizActions = ({ quiz, onChanged }: { quiz: Quiz; onChanged: () => void }) => {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const action = useAction(onChanged);
  const params = { offeringId: quiz.offeringId, quizId: quiz.id };
  const published = quiz.status === "published";
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={`Manage ${quiz.title}`} className="flex flex-wrap items-center gap-2">
        <Button variant={published ? "secondary" : "primary"} icon={published ? <EyeSlash aria-hidden /> : <Eye aria-hidden />} loading={action.running("publish")} disabled={action.busy}
          onClick={() => void action.run("publish", async (client) => {
            const next = await client.call("teacher.publishQuiz", { params, body: { published: !published } });
            return next.status === "published" ? `Published ${next.title} to the class.` : `${next.title} is a draft again; students can't see it.`;
          })}>
          {published ? "Unpublish" : "Publish"}
        </Button>
        <a href={routeHref({ screen: "quiz-results", offeringId: quiz.offeringId, quizId: quiz.id })}>Results and grading</a>
        {confirmingDelete
          ? (
            <>
              <Text size="sm" as="span">Delete this quiz? A quiz students have started can't be deleted.</Text>
              <Button size="sm" variant="primary" loading={action.running("delete")} disabled={action.busy}
                onClick={() => void action.run("delete", async (client) => {
                  await client.call("teacher.deleteQuiz", { params });
                  navigate({ screen: "quizzes", offeringId: quiz.offeringId });
                  return `Deleted ${quiz.title}.`;
                })}>
                Delete quiz
              </Button>
              <Button size="sm" onClick={() => setConfirmingDelete(false)}>Keep it</Button>
            </>
          )
          : <Button size="sm" variant="ghost" icon={<Trash aria-hidden />} onClick={() => setConfirmingDelete(true)}>Delete</Button>}
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </div>
  );
};

/** Building one quiz: its details, settings and questions, and publishing it. */
export const QuizBuilderPage = ({ teaching, quizId }: { teaching: TeachingOffering; quizId: string }) => {
  const offeringId = teaching.offering.id;
  const data = useLoad(`quiz:${offeringId}:${quizId}`, async (client) => {
    const [quiz, listing, assignments, outline] = await Promise.all([
      client.call("teacher.getQuiz", { params: { offeringId, quizId } }),
      client.call("teacher.listQuizzes", { params: { offeringId } }),
      client.call("teacher.listAssignments", { params: { offeringId } }),
      client.call("teacher.listModules", { params: { offeringId } }),
    ]);
    const summary = listing.quizzes.find((q) => q.quiz.id === quizId);
    return { quiz, assignments, modules: outline.outline.modules, started: (summary?.started ?? 0) > 0 };
  });

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Quiz">
        <a href={routeHref({ screen: "quizzes", offeringId })}>All quizzes</a>
      </nav>
      {data.status === "loading" && <Loading label="Opening the quiz…" />}
      {data.status === "error" && <Problem error={data.error} onRetry={data.reload} />}
      {data.status === "ready" && (
        <>
          <PageHeading>{`${data.data.quiz.title} · ${classLabel(teaching)}`}</PageHeading>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={data.data.quiz.status === "published" ? "success" : "neutral"}>{data.data.quiz.status === "published" ? "Published" : "Draft"}</Badge>
            <Text variant="secondary" size="sm" as="span">{`${data.data.quiz.items.length} question${data.data.quiz.items.length === 1 ? "" : "s"}`}</Text>
          </div>
          <QuizActions quiz={data.data.quiz} onChanged={data.reload} />
          <QuizForm
            key={data.data.quiz.updatedAt}
            quiz={data.data.quiz}
            assignments={data.data.assignments}
            modules={data.data.modules}
            started={data.data.started}
            onSaved={data.reload}
          />
        </>
      )}
    </div>
  );
};
