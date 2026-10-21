import type { RubricDraft } from "../types.ts";

/** The three levels every simple rubric criterion has, lowest first. */
export const SIMPLE_LEVELS = [
  { id: "beginning", label: "Beginning", points: 1 },
  { id: "developing", label: "Developing", points: 2 },
  { id: "secure", label: "Secure", points: 3 },
] as const;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "rubric";

/**
 * A rubric draft from a title and criterion names, each with the {@link SIMPLE_LEVELS}, and an
 * optional automatic length check on the first criterion. `suffix` keeps two rubrics with the
 * same title apart.
 */
export const simpleRubricDraft = (input: { title: string; criteria: readonly string[]; minWords: number | undefined; suffix: string }): RubricDraft => {
  const used = new Set<string>();
  const criteria = input.criteria.map((title, index) => {
    let id = slug(title);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const checks = index === 0 && input.minWords !== undefined
      ? [{ id: "length", evaluatorId: "writing.structure", visibility: "student-visible" as const, config: { minWords: input.minWords } }]
      : [];
    return { id, title, levels: SIMPLE_LEVELS.map((level) => ({ ...level })), checks };
  });
  return { rubricId: `rbr_${slug(input.title)}-${input.suffix}`, version: 1, title: input.title, criteria };
};
