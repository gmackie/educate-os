import { useState } from "react";
import { Button, Input, InputArea, Radio, Text } from "@cloudflare/kumo";
import { Seal } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { RubricRef } from "../types.ts";
import { useRubricShelf } from "./RubricShelf.tsx";
import { SIMPLE_LEVELS, simpleRubricDraft } from "./simpleRubric.ts";

/** A rubric the teacher can pick: a signed rubric with its title, or one an earlier activity used. */
export interface RubricChoice {
  ref: RubricRef;
  label: string;
}

const refKey = (ref: RubricRef) => `${ref.rubricId}@${ref.version}`;

/**
 * Chooses the activity's rubric from the signed rubrics the teacher can use, or signs a simple new
 * one. A rubric is signed when it is created, so what students are assessed against cannot change
 * afterwards.
 */
export const RubricChooser = ({ offeringId, earlier, value, onChange }: {
  offeringId: string;
  earlier: readonly RubricChoice[];
  value: RubricRef | undefined;
  onChange: (rubric: RubricRef | undefined) => void;
}) => {
  const shelf = useRubricShelf();
  const choices: RubricChoice[] = [
    ...shelf.rubrics.map((rubric) => ({ ref: { rubricId: rubric.rubricId, version: rubric.version }, label: rubric.title })),
    ...earlier,
  ].filter((choice, index, all) => all.findIndex((c) => refKey(c.ref) === refKey(choice.ref)) === index);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2"><Text variant="heading" as="span">Rubric</Text></legend>
      <Radio.Group
        legend="Assess the work against"
        value={value === undefined ? "none" : refKey(value)}
        onValueChange={(key) => onChange(choices.find((choice) => refKey(choice.ref) === key)?.ref)}
      >
        <Radio.Item value="none" label="No rubric" />
        {choices.map((choice) => <Radio.Item key={refKey(choice.ref)} value={refKey(choice.ref)} label={choice.label} />)}
      </Radio.Group>
      <SimpleRubricBuilder offeringId={offeringId} onSigned={onChange} />
    </fieldset>
  );
};

const SimpleRubricBuilder = ({ offeringId, onSigned }: { offeringId: string; onSigned: (rubric: RubricRef) => void }) => {
  const client = useDistrictApi();
  const shelf = useRubricShelf();
  const announce = useAnnounce();
  const [title, setTitle] = useState("");
  const [criteria, setCriteria] = useState("");
  const [minWords, setMinWords] = useState("");
  const [state, setState] = useState<{ status: "idle" | "signing" } | { status: "failed"; error: unknown }>({ status: "idle" });
  const names = criteria.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const words = /^\d+$/.test(minWords.trim()) ? Number(minWords.trim()) : undefined;

  const sign = async () => {
    setState({ status: "signing" });
    try {
      const draft = simpleRubricDraft({ title: title.trim(), criteria: names, minWords: words, suffix: crypto.randomUUID().slice(0, 8) });
      const release = await client.call("teacher.signRubric", { params: { offeringId }, body: { rubric: draft } });
      shelf.add(release);
      onSigned({ rubricId: release.rubricId, version: release.version });
      setTitle("");
      setCriteria("");
      setMinWords("");
      setState({ status: "idle" });
      announce(`Rubric “${release.title}” is signed and chosen.`);
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <div role="group" aria-label="Create a simple rubric" className="flex flex-col gap-2 rounded border border-kumo-line p-3">
      <Text bold>Create a simple rubric</Text>
      <Text variant="secondary" size="sm">{`Each criterion gets three levels: ${SIMPLE_LEVELS.map((l) => `${l.label} (${l.points})`).join(", ")}.`}</Text>
      <Input label="Rubric title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea label="Criteria" description="One per line" value={criteria} onValueChange={setCriteria} />
      <Input
        label="Automatic check: at least this many words"
        required={false}
        inputMode="numeric"
        description="Checks the first criterion. Leave empty for no automatic check."
        value={minWords}
        onChange={(event) => setMinWords(event.target.value)}
      />
      <div>
        <Button icon={<Seal aria-hidden />} loading={state.status === "signing"} disabled={title.trim() === "" || names.length === 0} onClick={() => void sign()}>
          Sign and use this rubric
        </Button>
      </div>
      {state.status === "failed" && <Problem error={state.error} />}
    </div>
  );
};
