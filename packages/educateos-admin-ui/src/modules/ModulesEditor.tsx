import { useState } from "react";
import { Badge, Button, Checkbox, Radio, Table, Text } from "@cloudflare/kumo";
import type { CapabilityId, OfferingId } from "@educateos/contracts";
import { className, count, packName, schoolName } from "../app/labels.ts";
import type { ConfigVersion } from "../app/useDistrictConfig.ts";
import { documentFromDesired, withModuleState, withRolloutClasses, type DesiredModule, type DesiredStateView, type ModuleState } from "../configDocument.ts";
import type { ProposedChange } from "./ChangeReview.tsx";
import type { ClassSummary } from "./classSurvey.ts";

type RolloutChoice = "selected" | "all";

/** A module's state as an administrator reads it: Off, On, or visible to classes. */
export function moduleStateLabel(module: DesiredModule, desired: DesiredStateView): string {
  if (module.state === "disabled") return "Off";
  const mode = module.state === "advisory" ? "On, advisory only" : "On";
  if (desired.rollout.target === "all-active-offerings") return `${mode}, visible to all active classes`;
  return desired.rollout.offerings.length === 0 ? mode : `${mode}, visible to ${count(desired.rollout.offerings.length, "selected class", "selected classes")}`;
}

function configSummary(config: Record<string, unknown>): string {
  const entries = Object.entries(config);
  if (entries.length === 0) return "No settings";
  return entries.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("; ");
}

interface ModulesEditorProps {
  /** The version in force, which the draft starts from. Remount with a `key` when it changes. */
  head: ConfigVersion;
  /** The classes modules can be rolled out to. */
  classes: readonly ClassSummary[];
  /** Called with the change to preview. */
  onPreview: (change: ProposedChange) => void;
}

/**
 * The capability packs and who sees them. Edits make a draft; nothing changes until the draft is
 * previewed and activated.
 */
export const ModulesEditor = ({ head, classes, onPreview }: ModulesEditorProps) => {
  const [draft, setDraft] = useState(head.desired);
  // A district whose modules are all off has rolled nothing out yet, so it starts from a pilot.
  const rolledOutToAll = head.desired.rollout.target === "all-active-offerings"
    && Object.values(head.desired.modules).some((m) => m.state !== "disabled");
  const [rollout, setRollout] = useState<RolloutChoice>(rolledOutToAll ? "all" : "selected");
  const [selected, setSelected] = useState<ReadonlySet<OfferingId>>(() => new Set(
    head.desired.rollout.target === "all-active-offerings" ? classes.filter((c) => c.visibleNow).map((c) => c.offeringId) : head.desired.rollout.offerings,
  ));

  const modules = Object.entries(draft.modules).toSorted(([a], [b]) => a.localeCompare(b)) as [CapabilityId, DesiredModule][];
  const toggleClass = (offeringId: OfferingId, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(offeringId);
    else next.delete(offeringId);
    setSelected(next);
  };

  const preview = () => {
    const next = rollout === "all"
      ? { ...draft, rollout: { ...draft.rollout, target: "all-active-offerings" as const, offerings: [] } }
      : withRolloutClasses(draft, [...selected]);
    onPreview({
      title: rollout === "all" ? "Preview: modules for all active classes" : `Preview: modules for ${count(selected.size, "class", "classes")}`,
      document: documentFromDesired(next),
      applyLabel: "Activate",
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="modules-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="modules-heading">Capability packs</Text>
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">Capability packs and their state</caption>
            <Table.Header>
              <Table.Row>
                <Table.Head>Module</Table.Head>
                <Table.Head>State now</Table.Head>
                <Table.Head>Needed by</Table.Head>
                <Table.Head>Settings</Table.Head>
                <Table.Head>Change to</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {modules.map(([id, module]) => {
                const now = head.desired.modules[id];
                return (
                  <Table.Row key={id}>
                    <Table.Cell><Text bold>{packName(id)}</Text></Table.Cell>
                    <Table.Cell>{now === undefined ? "Not installed" : moduleStateLabel(now, head.desired)}</Table.Cell>
                    <Table.Cell>{module.requiredBy?.map(packName).join(", ") ?? "—"}</Table.Cell>
                    <Table.Cell><Text variant="secondary" size="sm">{configSummary(module.config)}</Text></Table.Cell>
                    <Table.Cell>
                      <Radio.Group
                        legend={`${packName(id)} state`}
                        orientation="horizontal"
                        value={module.state === "disabled" ? "disabled" : module.state}
                        onValueChange={(value) => setDraft(withModuleState(draft, id, value as ModuleState))}
                      >
                        <Radio.Item value="disabled" label="Off" />
                        <Radio.Item value="enabled" label="On" />
                        {module.state === "advisory" && <Radio.Item value="advisory" label="Advisory" />}
                      </Radio.Group>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
        <Text variant="secondary" size="sm">
          A module needed by another turns on with it. Module settings are shown as configured; editing them here needs the district's settings forms.
        </Text>
      </section>

      <section aria-labelledby="rollout-heading" className="flex flex-col gap-3">
        <Text as="h3" variant="heading" id="rollout-heading">Rollout</Text>
        <Radio.Group legend="Who sees the modules that are on" value={rollout} onValueChange={(value) => setRollout(value as RolloutChoice)}>
          <Radio.Item value="selected" label="Selected classes (pilot)" />
          <Radio.Item value="all" label="Every active class" />
        </Radio.Group>
        {rollout === "selected" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium">Classes</legend>
            {classes.length === 0 && <Text variant="secondary">No active classes were found. Import a roster first.</Text>}
            <ul className="grid gap-2 sm:grid-cols-2">
              {classes.map((c) => (
                <li key={c.offeringId} className="rounded-md border border-kumo-line p-2">
                  <Checkbox
                    label={`${className(c.offeringId)} (${schoolName(c.schoolId)}): ${count(c.students, "student")}, ${count(c.staff, "staff member")}`}
                    checked={selected.has(c.offeringId)}
                    onCheckedChange={(checked) => toggleClass(c.offeringId, checked === true)}
                  />
                  {c.visibleNow && <Badge variant="success" className="ml-6">Using EducateOS now</Badge>}
                </li>
              ))}
            </ul>
            <Text variant="secondary" size="sm">{count(selected.size, "class", "classes")} selected.</Text>
          </fieldset>
        )}
      </section>

      <div>
        <Button variant="primary" onClick={preview} disabled={rollout === "selected" && selected.size === 0}>Preview changes</Button>
      </div>
    </div>
  );
};
