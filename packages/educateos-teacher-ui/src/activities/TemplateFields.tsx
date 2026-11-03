import { Button, Checkbox, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import { Plus, Trash } from "@phosphor-icons/react";
import { ANSWER_MODES, type ActivityForm } from "./activityForm.ts";

const GENRES = [
  { value: "argument", label: "Argument" },
  { value: "informative", label: "Informative" },
  { value: "narrative", label: "Narrative" },
  { value: "literary-analysis", label: "Literary analysis" },
] as const;

/** The fields the chosen template adds to every activity's own. */
export const TemplateFields = ({ form, onChange }: { form: ActivityForm; onChange: (form: ActivityForm) => void }) => {
  switch (form.template) {
    case "writing-task": {
      const writing = form.writing;
      const set = (change: Partial<ActivityForm["writing"]>) => onChange({ ...form, writing: { ...writing, ...change } });
      return (
        <div className="flex flex-col gap-3">
          <InputArea label="Prompt" value={writing.prompt} onValueChange={(prompt) => set({ prompt })} />
          <Radio.Group legend="Kind of writing" orientation="horizontal" value={writing.genre} onValueChange={(genre) => set({ genre: genre as ActivityForm["writing"]["genre"] })}>
            {GENRES.map((genre) => <Radio.Item key={genre.value} value={genre.value} label={genre.label} />)}
          </Radio.Group>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Minimum length in words" required={false} inputMode="numeric" value={writing.minWords} onChange={(event) => set({ minWords: event.target.value })} />
            <Input label="Sources to cite" inputMode="numeric" description="0 for none" value={writing.minimumCitations} onChange={(event) => set({ minimumCitations: event.target.value })} />
          </div>
        </div>
      );
    }
    case "science-investigation": {
      const science = form.science;
      const set = (change: Partial<ActivityForm["science"]>) => onChange({ ...form, science: { ...science, ...change } });
      return (
        <div className="flex flex-col gap-3">
          <InputArea label="Investigation question" value={science.question} onValueChange={(question) => set({ question })} />
          <InputArea label="What students describe about their method" value={science.methodPrompt} onValueChange={(methodPrompt) => set({ methodPrompt })} />
          <InputArea
            label="Data table columns"
            description="One per line, with its unit after a comma, such as: Mass change, %"
            value={science.dataColumns}
            onValueChange={(dataColumns) => set({ dataColumns })}
          />
          <InputArea label="Analysis prompt" value={science.analysisPrompt} onValueChange={(analysisPrompt) => set({ analysisPrompt })} />
        </div>
      );
    }
    case "primary-source-analysis": {
      const sources = form.sources;
      const set = (change: Partial<ActivityForm["sources"]>) => onChange({ ...form, sources: { ...sources, ...change } });
      return (
        <div className="flex flex-col gap-3">
          <Text variant="secondary">The resources you attach below are the primary sources.</Text>
          <InputArea label="Sourcing questions" description="One per line" value={sources.sourcingQuestions} onValueChange={(sourcingQuestions) => set({ sourcingQuestions })} />
          <InputArea label="Context questions" description="One per line" value={sources.contextualizationQuestions} onValueChange={(contextualizationQuestions) => set({ contextualizationQuestions })} />
          <InputArea label="Claim prompt" value={sources.claimPrompt} onValueChange={(claimPrompt) => set({ claimPrompt })} />
          <Input label="Pieces of evidence the claim must use" inputMode="numeric" value={sources.minimumEvidence} onChange={(event) => set({ minimumEvidence: event.target.value })} />
        </div>
      );
    }
    case "problem-set": {
      const problems = form.problems;
      const setItems = (items: ActivityForm["problems"]["items"]) => onChange({ ...form, problems: { ...problems, items } });
      return (
        <div className="flex flex-col gap-3">
          {problems.items.map((problem, index) => (
            <div key={index} role="group" aria-label={`Problem ${index + 1}`} className="flex flex-col gap-2 rounded border border-kumo-line p-3">
              <InputArea label={`Problem ${index + 1}`} value={problem.prompt} onValueChange={(prompt) => setItems(problems.items.map((p, i) => (i === index ? { ...p, prompt } : p)))} />
              <Input
                label={`Answer to problem ${index + 1}`}
                required={false}
                description="Goes into the answer key. Students never see it."
                value={problem.answer}
                onChange={(event) => setItems(problems.items.map((p, i) => (i === index ? { ...p, answer: event.target.value } : p)))}
              />
              {problems.items.length > 1 && (
                <Button variant="ghost" size="sm" icon={<Trash aria-hidden />} onClick={() => setItems(problems.items.filter((_, i) => i !== index))}>
                  {`Remove problem ${index + 1}`}
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button icon={<Plus aria-hidden />} onClick={() => setItems([...problems.items, { prompt: "", answer: "" }])}>Add a problem</Button>
          </div>
          <Checkbox label="Students show their reasoning" checked={problems.showWork} onCheckedChange={(showWork) => onChange({ ...form, problems: { ...problems, showWork: showWork === true } })} />
        </div>
      );
    }
    case "picture-response": {
      const picture = form.picture;
      const set = (change: Partial<ActivityForm["picture"]>) => onChange({ ...form, picture: { ...picture, ...change } });
      return (
        <div className="flex flex-col gap-3">
          <Text variant="secondary">Keep each prompt to a sentence or two: students can have every prompt read aloud to them. Attach a picture to look at as a resource below.</Text>
          <InputArea label="What students look at or listen to first" value={picture.lookPrompt} onValueChange={(lookPrompt) => set({ lookPrompt })} />
          <InputArea label="What students draw" description="Such as: Draw an animal that lives in a pond." value={picture.drawPrompt} onValueChange={(drawPrompt) => set({ drawPrompt })} />
          <Checkbox label="Students record themselves telling about their picture" checked={picture.tellAboutIt} onCheckedChange={(tellAboutIt) => set({ tellAboutIt: tellAboutIt === true })} />
          <InputArea label="Sentence starters" required={false} description="One per line, such as: I drew a ___." value={picture.sentenceFrames} onValueChange={(sentenceFrames) => set({ sentenceFrames })} />
        </div>
      );
    }
    case "read-and-respond": {
      const reading = form.reading;
      const set = (change: Partial<ActivityForm["reading"]>) => onChange({ ...form, reading: { ...reading, ...change } });
      return (
        <div className="flex flex-col gap-3">
          <InputArea label="The text students hear" description="A few short sentences. Students can have it read aloud." value={reading.passage} onValueChange={(passage) => set({ passage })} />
          <InputArea label="Questions" description="One per line. Each is its own step." value={reading.questions} onValueChange={(questions) => set({ questions })} />
          <Radio.Group legend="Students answer by" orientation="horizontal" value={reading.answerBy} onValueChange={(answerBy) => set({ answerBy: answerBy as ActivityForm["reading"]["answerBy"] })}>
            {ANSWER_MODES.map((mode) => <Radio.Item key={mode.mode} value={mode.mode} label={mode.label} />)}
          </Radio.Group>
          <InputArea label="Sentence starters" required={false} description="One per line, such as: The story is about ___." value={reading.sentenceFrames} onValueChange={(sentenceFrames) => set({ sentenceFrames })} />
        </div>
      );
    }
  }
};
