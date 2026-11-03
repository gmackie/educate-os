import type { ShowcaseRubric, ShowcaseRubricLevel } from "./types.ts";

/** Three levels for the youngest students, in words a five-year-old's family can read. */
export const EARLY_LEVELS: readonly ShowcaseRubricLevel[] = [
  { id: "not-yet", label: "Not yet", points: 1 },
  { id: "getting-there", label: "Getting there", points: 2 },
  { id: "got-it", label: "Got it!", points: 3 },
];

/** Four levels for grades 3 and up. */
export const FOUR_LEVELS: readonly ShowcaseRubricLevel[] = [
  { id: "beginning", label: "Beginning", points: 1 },
  { id: "developing", label: "Developing", points: 2 },
  { id: "proficient", label: "Proficient", points: 3 },
  { id: "advanced", label: "Advanced", points: 4 },
];

/** A rubric whose criteria all share one set of levels. */
export function rubric(
  rubricId: string,
  title: string,
  criteria: readonly (readonly [id: string, title: string])[],
  levels: readonly ShowcaseRubricLevel[] = FOUR_LEVELS,
): ShowcaseRubric {
  return { rubricId, title, criteria: criteria.map(([id, criterionTitle]) => ({ id, title: criterionTitle, levels })) };
}

/** The most points a rubric gives: the top level of each criterion. */
export function rubricMaxPoints(r: ShowcaseRubric): number {
  return r.criteria.reduce((sum, c) => sum + Math.max(...c.levels.map((l) => l.points)), 0);
}
