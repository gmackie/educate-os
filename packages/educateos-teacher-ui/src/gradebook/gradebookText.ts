import type { GradebookCell, GradebookColumn, GradebookSettings, GradeMarker } from "../types.ts";

/** What each marker is called on screen. */
export const MARKER_LABELS: Record<GradeMarker, string> = { excused: "Excused", missing: "Missing", late: "Late" };

/** A total in percent, or a dash while nothing counts toward it. */
export const percentText = (percent: number | null): string => (percent === null ? "—" : `${percent.toFixed(1)}%`);

/**
 * A cell's score as the class's settings combine it: points (`8/10`) or a percentage. A missing
 * assignment counted as zero shows its zero; an ungraded one shows nothing.
 */
export const scoreText = (cell: GradebookCell, column: GradebookColumn, calculation: GradebookSettings["calculation"]): string | undefined => {
  if (cell.score !== undefined) return calculation === "percent" ? `${cell.percent?.toFixed(1)}%` : `${cell.score.points}/${cell.score.maxPoints}`;
  if (!cell.counted) return undefined;
  return calculation === "percent" || column.pointsPossible === null ? "0%" : `0/${column.pointsPossible}`;
};
