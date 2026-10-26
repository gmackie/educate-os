import { useState } from "react";
import { Banner, Button, Dialog, Input, Radio, Switch, Text } from "@cloudflare/kumo";
import { GearSix, Plus, Trash, WarningCircle } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { Gradebook } from "../types.ts";
import { draftOf, settingsOf, type SettingsDraft } from "./settingsDraft.ts";

const SettingsForm = ({ gradebook, onSaved }: { gradebook: Gradebook; onSaved: () => void }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(gradebook.settings));
  const [state, setState] = useState<{ status: "editing" | "saving" } | { status: "invalid"; problem: string } | { status: "failed"; error: unknown }>({ status: "editing" });
  const change = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const weightSum = draft.groups.reduce((sum, g) => sum + (Number(g.weight) || 0), 0);

  const save = async () => {
    const result = settingsOf(draft, gradebook.columns);
    if ("problem" in result) {
      setState({ status: "invalid", problem: result.problem });
      return;
    }
    setState({ status: "saving" });
    try {
      await client.call("teacher.updateGradebookSettings", { params: { offeringId: gradebook.offeringId }, body: { revision: gradebook.revision, settings: result.settings } });
      announce("Gradebook settings saved. The totals are updated.");
      onSaved();
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <form
      aria-label="Gradebook settings"
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Dialog.Title className="text-lg font-semibold">Gradebook settings</Dialog.Title>
      <Dialog.Description>How this class's totals and letter grades add up. Official grades never change here.</Dialog.Description>

      <Radio.Group legend="Final grade" value={draft.weighting} onValueChange={(value) => change({ weighting: value as SettingsDraft["weighting"] })}>
        <Radio.Item value="none" label="All scores together" description="Every counted score adds up, whatever group it is in." />
        <Radio.Item value="group-weights" label="Weighted by group" description="Each group counts for its weight. Groups with nothing graded yet are left out." />
      </Radio.Group>
      <Radio.Group legend="Combine scores by" value={draft.calculation} onValueChange={(value) => change({ calculation: value as SettingsDraft["calculation"] })}>
        <Radio.Item value="points" label="Points" description="Points earned over points possible, so bigger assignments count for more." />
        <Radio.Item value="percent" label="Percent" description="Every assignment counts the same, whatever it is out of." />
      </Radio.Group>
      <Switch
        label="Count work marked missing as zero"
        checked={draft.missing === "zero"}
        onClick={() => change({ missing: draft.missing === "zero" ? "exclude" : "zero" })}
      />

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">Assignment groups</legend>
        {draft.groups.length === 0 ? <Text variant="secondary">No groups yet. Add one to weight or drop scores.</Text> : null}
        {draft.groups.map((group, index) => {
          const label = group.name.trim() === "" ? `Group ${index + 1}` : group.name.trim();
          const update = (patch: Partial<typeof group>) => change({ groups: draft.groups.map((g) => (g.id === group.id ? { ...g, ...patch } : g)) });
          return (
            <div key={group.id} role="group" aria-label={label} className="flex flex-col gap-2 rounded-lg border border-kumo-line p-3 sm:flex-row sm:items-end">
              <div className="min-w-0 grow"><Input className="w-full" label="Group name" maxLength={100} value={group.name} onChange={(e) => update({ name: e.target.value })} /></div>
              <div className="min-w-0 sm:w-28"><Input className="w-full" label="Weight (%)" type="number" min={0} max={100} step="any" value={group.weight} onChange={(e) => update({ weight: e.target.value })} /></div>
              <div className="min-w-0 sm:w-28"><Input className="w-full" label="Drop lowest" type="number" min={0} max={20} step={1} value={group.dropLowest} onChange={(e) => update({ dropLowest: e.target.value })} /></div>
              <Button
                variant="secondary-destructive"
                icon={<Trash aria-hidden />}
                aria-label={`Remove ${label}`}
                onClick={() => change({
                  groups: draft.groups.filter((g) => g.id !== group.id),
                  groupOf: Object.fromEntries(Object.entries(draft.groupOf).filter(([, id]) => id !== group.id)),
                })}
              />
            </div>
          );
        })}
        {draft.weighting === "group-weights" && draft.groups.length > 0 && weightSum !== 100 ? (
          <Text variant="secondary">{`The weights add up to ${weightSum}%. Each group counts in proportion to its weight.`}</Text>
        ) : null}
        <div>
          <Button
            icon={<Plus aria-hidden />}
            onClick={() => change({ groups: [...draft.groups, { id: `grp_${crypto.randomUUID()}`, name: "", weight: "0", dropLowest: "0" }] })}
          >
            Add group
          </Button>
        </div>
      </fieldset>

      {draft.groups.length > 0 && gradebook.columns.length > 0 ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 font-semibold">Which group each assignment is in</legend>
          {gradebook.columns.map((column) => (
            <Radio.Group
              key={column.assignmentId}
              legend={column.title}
              orientation="horizontal"
              value={draft.groupOf[column.assignmentId] ?? ""}
              onValueChange={(value) => change({ groupOf: { ...draft.groupOf, [column.assignmentId]: value as string } })}
            >
              <Radio.Item value="" label="No group" />
              {draft.groups.map((group, index) => <Radio.Item key={group.id} value={group.id} label={group.name.trim() === "" ? `Group ${index + 1}` : group.name.trim()} />)}
            </Radio.Group>
          ))}
        </fieldset>
      ) : null}

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 font-semibold">Grade scale</legend>
        {draft.scale.map((cutoff, index) => {
          const last = index === draft.scale.length - 1;
          const update = (patch: Partial<typeof cutoff>) => change({ scale: draft.scale.map((c, i) => (i === index ? { ...c, ...patch } : c)) });
          return (
            <div key={index} role="group" aria-label={`Grade ${index + 1}`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 sm:w-28"><Input className="w-full" label="Letter" maxLength={12} value={cutoff.letter} onChange={(e) => update({ letter: e.target.value })} /></div>
              <div className="min-w-0 sm:w-36">
                <Input
                  className="w-full"
                  label="From (%)"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={last ? "0" : cutoff.minPercent}
                  disabled={last}
                  onChange={(e) => update({ minPercent: e.target.value })}
                />
              </div>
              {draft.scale.length > 1 ? (
                <Button
                  variant="secondary-destructive"
                  icon={<Trash aria-hidden />}
                  aria-label={`Remove grade ${cutoff.letter.trim() === "" ? index + 1 : cutoff.letter.trim()}`}
                  onClick={() => change({ scale: draft.scale.filter((_, i) => i !== index) })}
                />
              ) : null}
              {/* Under the row rather than under its field, so every row's controls line up. */}
              {last ? <span className="sm:self-center"><Text variant="secondary" size="sm" as="span">The lowest grade starts at 0.</Text></span> : null}
            </div>
          );
        })}
        <div>
          <Button icon={<Plus aria-hidden />} onClick={() => change({ scale: [...draft.scale.slice(0, -1), { letter: "", minPercent: "" }, ...draft.scale.slice(-1)] })}>
            Add grade
          </Button>
        </div>
      </fieldset>

      {state.status === "invalid" ? <div role="alert"><Banner variant="error" icon={<WarningCircle aria-hidden />} title={state.problem} /></div> : null}
      {state.status === "failed" ? <Problem error={state.error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Dialog.Close render={(props) => <Button {...props}>Cancel</Button>} />
        <Button type="submit" variant="primary" loading={state.status === "saving"}>Save settings</Button>
      </div>
    </form>
  );
};

/**
 * The class's gradebook settings: groups with weights and drop-lowest, how scores combine, whether
 * missing work counts as zero, and the letter scale. Saved over the revision the teacher opened,
 * so a change someone else saved meanwhile is reported rather than overwritten.
 */
export const SettingsDialog = ({ gradebook, onSaved }: { gradebook: Gradebook; onSaved: () => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={(props) => <Button {...props} icon={<GearSix aria-hidden />}>Gradebook settings</Button>} />
      <Dialog className="flex max-h-[85vh] flex-col overflow-y-auto p-6" size="xl">
        {open ? (
          <SettingsForm
            gradebook={gradebook}
            onSaved={() => {
              setOpen(false);
              onSaved();
            }}
          />
        ) : null}
      </Dialog>
    </Dialog.Root>
  );
};
