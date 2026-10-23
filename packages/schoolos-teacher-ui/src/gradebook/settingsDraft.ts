// The gradebook settings form's state: what the teacher types, kept as text until it is saved, and
// the checks that turn it back into settings the district accepts.
import type { GradebookColumn, GradebookSettings } from "../types.ts";

/** One assignment group as the form edits it. */
export interface GroupDraft {
  id: string;
  name: string;
  weight: string;
  dropLowest: string;
}

/** One grade cutoff as the form edits it. */
export interface CutoffDraft {
  letter: string;
  minPercent: string;
}

/** The whole form. `groupOf` maps each assignment to its group's ID, or `""` for none. */
export interface SettingsDraft {
  weighting: GradebookSettings["weighting"];
  calculation: GradebookSettings["calculation"];
  missing: GradebookSettings["missing"];
  groups: GroupDraft[];
  groupOf: Record<string, string>;
  scale: CutoffDraft[];
}

/** The form for the class's current settings. */
export const draftOf = (settings: GradebookSettings): SettingsDraft => ({
  weighting: settings.weighting,
  calculation: settings.calculation,
  missing: settings.missing,
  groups: settings.groups.map((g) => ({ id: g.id, name: g.name, weight: String(g.weight), dropLowest: String(g.dropLowest) })),
  groupOf: Object.fromEntries(settings.groups.flatMap((g) => g.assignmentIds.map((id) => [id, g.id]))),
  scale: settings.scale.map((c) => ({ letter: c.letter, minPercent: String(c.minPercent) })),
});

const number = (text: string): number | undefined => (text.trim() === "" || !Number.isFinite(Number(text)) ? undefined : Number(text));

/** The settings a draft describes, or the first problem with it in words a teacher can act on. */
export const settingsOf = (draft: SettingsDraft, columns: readonly GradebookColumn[]): { settings: GradebookSettings } | { problem: string } => {
  const groups: GradebookSettings["groups"] = [];
  for (const g of draft.groups) {
    const name = g.name.trim();
    const weight = number(g.weight);
    const dropLowest = number(g.dropLowest);
    if (name === "") return { problem: "Give every group a name." };
    if (weight === undefined || weight < 0 || weight > 100) return { problem: `The weight of ${name} must be between 0 and 100.` };
    if (dropLowest === undefined || !Number.isInteger(dropLowest) || dropLowest < 0 || dropLowest > 20) return { problem: `${name} can drop between 0 and 20 lowest scores.` };
    const assignmentIds = columns.filter((c) => draft.groupOf[c.assignmentId] === g.id).map((c) => c.assignmentId);
    groups.push({ id: g.id as GradebookSettings["groups"][number]["id"], name, weight, dropLowest, assignmentIds });
  }
  if (draft.weighting === "group-weights" && !groups.some((g) => g.weight > 0)) return { problem: "To weight by group, give at least one group a weight." };

  const scale: GradebookSettings["scale"] = [];
  for (const [i, c] of draft.scale.entries()) {
    const letter = c.letter.trim();
    const minPercent = i === draft.scale.length - 1 ? 0 : number(c.minPercent);
    if (letter === "") return { problem: "Give every grade on the scale a letter." };
    if (minPercent === undefined || minPercent < 0 || minPercent > 100) return { problem: `The lowest percentage for ${letter} must be between 0 and 100.` };
    if (i > 0 && minPercent >= scale[i - 1]!.minPercent) return { problem: `${letter} must start below ${scale[i - 1]!.letter}.` };
    if (scale.some((s) => s.letter === letter)) return { problem: `${letter} is on the scale twice.` };
    scale.push({ letter, minPercent });
  }
  return { settings: { weighting: draft.weighting, calculation: draft.calculation, missing: draft.missing, groups, scale } };
};
