import type { CheckRun, CriterionScore, RubricRelease } from "../types.ts";

/** A rubric criterion as the review scores it. */
export interface ReviewCriterion {
  id: string;
  title: string;
  /** The most points it is worth, where known. */
  maxPoints: number | undefined;
  /** Its levels, lowest first, where the rubric is known. */
  levels: readonly { id: string; label: string; points: number }[];
}

/**
 * The criteria a submission is scored on, from the best source at hand: the signed rubric itself,
 * else the automatic checks' report of it, else the criteria already scored.
 */
export const reviewCriteria = (rubric: RubricRelease | undefined, run: CheckRun | undefined, scores: readonly CriterionScore[]): ReviewCriterion[] => {
  if (rubric !== undefined) {
    return rubric.criteria.map((c) => ({ id: c.id, title: c.title, maxPoints: c.levels.at(-1)?.points, levels: c.levels }));
  }
  const report = run?.run.report;
  if (report !== undefined) {
    return report.criteria.map((c) => ({ id: c.criterionId, title: c.title, maxPoints: c.suggestions[0]?.maxPoints, levels: [] }));
  }
  const ids = [...new Set(scores.map((s) => s.criterionId))];
  return ids.map((id) => ({ id, title: id, maxPoints: scores.find((s) => s.criterionId === id && s.maxPoints !== undefined)?.maxPoints, levels: [] }));
};

/** The teacher's own score for a criterion, if they entered one. Suggestions never count. */
export const teacherScore = (scores: readonly CriterionScore[], criterionId: string): CriterionScore | undefined =>
  scores.find((s) => s.criterionId === criterionId && s.source.kind === "teacher");

/**
 * The official grade the teacher's own criterion scores add up to. Suggested scores are left out:
 * a suggestion reaches the grade only once the teacher enters it as their score.
 */
export const teacherTotal = (criteria: readonly ReviewCriterion[], scores: readonly CriterionScore[]): { points: number; maxPoints: number } | undefined => {
  let points = 0;
  let maxPoints = 0;
  for (const criterion of criteria) {
    const own = teacherScore(scores, criterion.id);
    const max = own?.maxPoints ?? criterion.maxPoints;
    if (own === undefined || max === undefined) return undefined;
    points += own.points;
    maxPoints += max;
  }
  return criteria.length === 0 ? undefined : { points, maxPoints };
};
