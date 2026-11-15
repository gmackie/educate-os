import { useState } from "react";
import { Button, Checkbox, Input, InputArea, Radio } from "@cloudflare/kumo";
import {
  prepareTeacherBrief,
  TEACHER_INTEGRATION_LEVELS,
  TEACHER_MATERIALS,
  type TeacherIntegrationLevel,
} from "./teacherBrief";

export const TeacherIntake = ({ onPrepare }: { onPrepare: (brief: string) => void }) => {
  const [subject, setSubject] = useState("");
  const [learners, setLearners] = useState("");
  const [outcome, setOutcome] = useState("");
  const [materials, setMaterials] = useState<string[]>([TEACHER_MATERIALS[0]]);
  const [level, setLevel] = useState<TeacherIntegrationLevel>("reuse");

  return (
    <form
      aria-label="Your classroom brief"
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!subject.trim() || !outcome.trim()) return;
        onPrepare(prepareTeacherBrief({ subject, learners, outcome, materials, level }));
      }}
    >
      <div className="flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-4 sm:p-6">
        <h2 className="text-lg font-medium text-kumo-default">Start with one lesson</h2>
        <Input label="Subject or teaching area" placeholder="For example, middle school science" required maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} />
        <Input label="Learner level and needs (optional)" placeholder="For example, grade 7, mixed reading levels" maxLength={500} value={learners} onChange={(event) => setLearners(event.target.value)} />
        <InputArea label="What would you like to make easier?" placeholder="For example, turn my ecosystem worksheet into guided practice with useful hints." required maxLength={2000} rows={3} value={outcome} onValueChange={setOutcome} />
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 font-medium text-kumo-default">What do you already use?</legend>
        {TEACHER_MATERIALS.map((material) => (
          <Checkbox key={material} label={material} checked={materials.includes(material)} onCheckedChange={(checked) => setMaterials((previous) => checked === true
            ? [...previous, material]
            : previous.filter((item) => item !== material))} />
        ))}
        <p className="text-sm text-kumo-subtle">You can combine lesson documents and slides, Google Drive or Classroom sources, and Common Cartridge course exports. You’ll attach files or choose specific connections after reviewing your brief. Selecting a source does not import it.</p>
      </fieldset>
      <Radio.Group legend="How would you like to start?" appearance="card" value={level} onValueChange={(value) => setLevel(value as TeacherIntegrationLevel)}>
        {TEACHER_INTEGRATION_LEVELS.map(({ value, label, description }) => (
          <Radio.Item key={value} value={value} label={label} description={description} />
        ))}
      </Radio.Group>
      <p className="text-sm text-kumo-subtle">We’ll prepare an editable request to compare these options using your materials. Nothing is sent to AI until you send the brief.</p>
      <Button type="submit" variant="primary" disabled={!subject.trim() || !outcome.trim()}>Prepare my brief</Button>
    </form>
  );
};
