// The gradebook (SCHO-187): an offering's assignments as columns, its students as rows, and the
// totals a teacher's settings make of them. Every cell is read from the latest official grade
// version alone; proposals, suggested scores and Assessment CI results never reach it. Settings and
// markers change what the totals count, never an official grade.
import { z } from "zod";
import { OfferingId, PrincipalId } from "@educateos/contracts";
import { AssignmentId, GradeScore, type AssignmentBinding, type OfficialGradeVersion } from "./model.ts";

/** Identifies an assignment group within its offering's gradebook. The teacher's client chooses it. */
export const GradebookGroupId = z.string().regex(/^grp_[a-z0-9][a-z0-9-]{0,62}$/, "expected an assignment group ID (grp_…)").brand<"gradebook-group">();
/** An assignment group identifier. */
export type GradebookGroupId = z.infer<typeof GradebookGroupId>;

/**
 * A set of an offering's assignments counted together, such as homework or tests. Its `weight` is
 * its share of the weighted total, in percent; weights need not add up to 100, because the
 * weighted total is taken over the groups that have something counted. Its `dropLowest` lowest
 * counted scores are left out, but never its last one.
 */
export const AssignmentGroup = z.strictObject({
  id: GradebookGroupId,
  name: z.string().trim().min(1).max(100),
  weight: z.number().min(0).max(100),
  dropLowest: z.int().min(0).max(20),
  assignmentIds: z.array(AssignmentId).max(500),
});
/** An assignment group. */
export type AssignmentGroup = z.infer<typeof AssignmentGroup>;

/** One letter grade and the lowest final percentage that earns it. */
export const GradeCutoff = z.strictObject({
  letter: z.string().trim().min(1).max(12),
  minPercent: z.number().min(0).max(100),
});
/** A grade cutoff. */
export type GradeCutoff = z.infer<typeof GradeCutoff>;

/** An offering's letter grades, highest first, ending at 0 so every percentage has a letter. */
export const GradeScale = z.array(GradeCutoff).min(1).max(20).superRefine((scale, ctx) => {
  if (scale.some((cutoff, i) => i > 0 && cutoff.minPercent >= scale[i - 1]!.minPercent)) {
    ctx.addIssue({ code: "custom", message: "cutoffs are listed from the highest percentage down, each lower than the last" });
  }
  if (scale.at(-1)!.minPercent !== 0) ctx.addIssue({ code: "custom", message: "the lowest cutoff is 0%" });
  if (new Set(scale.map((c) => c.letter)).size !== scale.length) ctx.addIssue({ code: "custom", message: "each letter is used once" });
});
/** A grade scale. */
export type GradeScale = z.infer<typeof GradeScale>;

/** The scale an offering uses until its teacher sets one. */
export const DEFAULT_GRADE_SCALE: GradeScale = [
  { letter: "A", minPercent: 90 },
  { letter: "B", minPercent: 80 },
  { letter: "C", minPercent: 70 },
  { letter: "D", minPercent: 60 },
  { letter: "F", minPercent: 0 },
];

/**
 * How an offering's gradebook adds up, set by its teacher:
 * - `weighting`: whether the final grade is the weighted total of the groups (`group-weights`) or
 *   the unweighted total of every counted score (`none`). Both totals are always computed.
 * - `calculation`: whether scores combine by `points` (points earned over points possible) or by
 *   `percent` (each assignment counts the same, whatever it is out of).
 * - `missing`: whether an ungraded assignment the teacher marked missing counts as `zero` or is
 *   left out (`exclude`).
 * - `groups`: the assignment groups. An assignment is in at most one; one in none counts toward the
 *   unweighted total only.
 * - `scale`: the letter grades.
 */
export const GradebookSettings = z.strictObject({
  weighting: z.enum(["none", "group-weights"]),
  calculation: z.enum(["points", "percent"]),
  missing: z.enum(["zero", "exclude"]),
  groups: z.array(AssignmentGroup).max(20),
  scale: GradeScale,
}).superRefine((settings, ctx) => {
  if (new Set(settings.groups.map((g) => g.id)).size !== settings.groups.length) ctx.addIssue({ code: "custom", path: ["groups"], message: "each group has its own ID" });
  const grouped = settings.groups.flatMap((g) => g.assignmentIds);
  if (new Set(grouped).size !== grouped.length) ctx.addIssue({ code: "custom", path: ["groups"], message: "an assignment is in at most one group" });
});
/** Gradebook settings. */
export type GradebookSettings = z.infer<typeof GradebookSettings>;

/** The settings of an offering whose teacher has set none. */
export const DEFAULT_GRADEBOOK_SETTINGS: GradebookSettings = {
  weighting: "none",
  calculation: "points",
  missing: "zero",
  groups: [],
  scale: DEFAULT_GRADE_SCALE,
};

/**
 * What a teacher has marked about one student's assignment:
 * - `excused`: left out of every total, graded or not.
 * - `missing`: if it is ungraded, counted as zero or left out, as the settings say.
 * - `late`: shown beside the grade; it changes no total.
 */
export const GradeMarker = z.enum(["excused", "missing", "late"]);
/** A grade marker. */
export type GradeMarker = z.infer<typeof GradeMarker>;

/** A marker on one cell of an offering's gradebook, and who set it. */
export const GradeMarkerRecord = z.strictObject({
  assignmentId: AssignmentId,
  studentPrincipalId: PrincipalId,
  marker: GradeMarker,
  setBy: PrincipalId,
  setAt: z.iso.datetime(),
});
/** A grade marker record. */
export type GradeMarkerRecord = z.infer<typeof GradeMarkerRecord>;

/**
 * One column of the gradebook: an assignment of the offering. `(offeringId, assignmentId)` is the
 * key an LMS `GradeColumnBinding` maps a passback column onto, so a column here and a column there
 * name the same official grades. `pointsPossible` is the largest `maxPoints` its official grades
 * were given, or `null` before any; a missing score counts as zero out of it.
 */
export const GradebookColumn = z.strictObject({
  offeringId: OfferingId,
  assignmentId: AssignmentId,
  title: z.string(),
  dueAt: z.iso.datetime(),
  groupId: GradebookGroupId.optional(),
  pointsPossible: z.number().positive().nullable(),
});
/** A gradebook column. */
export type GradebookColumn = z.infer<typeof GradebookColumn>;

/**
 * One student's assignment. `score` and `version` are the latest official grade version's, and
 * nothing else is ever shown as a score. `percent` is what the cell is worth in the totals' terms
 * (a missing score counted as zero is 0), or `null` if it has none. `counted` says whether the
 * totals include it; `dropped`, that its group's drop-lowest setting left it out.
 */
export const GradebookCell = z.strictObject({
  assignmentId: AssignmentId,
  score: GradeScore.optional(),
  version: z.int().positive().optional(),
  marker: GradeMarker.optional(),
  percent: z.number().nullable(),
  counted: z.boolean(),
  dropped: z.boolean(),
});
/** A gradebook cell. */
export type GradebookCell = z.infer<typeof GradebookCell>;

/** One student's total for an assignment group: `null` while it counts nothing. */
export const GroupTotal = z.strictObject({ groupId: GradebookGroupId, percent: z.number().nullable() });
/** A group total. */
export type GroupTotal = z.infer<typeof GroupTotal>;

/**
 * One student's running totals, in percent, each `null` while nothing counts toward it.
 * `points` adds up every counted, undropped score. `final` is `weighted` or `unweighted` as the
 * settings' `weighting` says, and `letter` is its grade on the scale.
 */
export const GradebookTotals = z.strictObject({
  points: z.strictObject({ earned: z.number(), possible: z.number() }),
  unweighted: z.number().nullable(),
  weighted: z.number().nullable(),
  final: z.number().nullable(),
  letter: z.string().nullable(),
});
/** Gradebook totals. */
export type GradebookTotals = z.infer<typeof GradebookTotals>;

/** One student's row: a cell per column, in column order, then their group and overall totals. */
export const GradebookRow = z.strictObject({
  studentPrincipalId: PrincipalId,
  displayName: z.string(),
  cells: z.array(GradebookCell),
  groups: z.array(GroupTotal),
  totals: GradebookTotals,
});
/** A gradebook row. */
export type GradebookRow = z.infer<typeof GradebookRow>;

/** A student the gradebook has a row for. */
export interface GradebookStudent {
  principalId: PrincipalId;
  displayName: string;
}

/** Everything a gradebook is computed from. */
export interface GradebookInput {
  offeringId: OfferingId;
  /** The offering's assignments. Others are ignored. */
  assignments: readonly AssignmentBinding[];
  /** Official grade versions; only each student's latest for each assignment is read. */
  versions: readonly OfficialGradeVersion[];
  settings: GradebookSettings;
  markers: readonly GradeMarkerRecord[];
  /** The rows, in the order given. */
  students: readonly GradebookStudent[];
}

/** A computed gradebook. */
export interface ComputedGradebook {
  columns: GradebookColumn[];
  rows: GradebookRow[];
}

/** Rounds a percentage or point total for display and export, so 89.995 and 89.99499… agree. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The offering's assignments as columns: by due date, then title, then ID, so the order never depends on storage. */
export function gradebookColumns(input: Pick<GradebookInput, "offeringId" | "assignments" | "versions" | "settings">): GradebookColumn[] {
  const groupOf = new Map(input.settings.groups.flatMap((g) => g.assignmentIds.map((id) => [id, g.id] as const)));
  return input.assignments
    .filter((a) => a.offeringId === input.offeringId)
    .toSorted((a, b) => compare(a.dueAt, b.dueAt) || compare(a.title, b.title) || compare(a.id, b.id))
    .map((a) => {
      const maxima = input.versions.filter((v) => v.assignmentId === a.id).map((v) => v.score.maxPoints);
      const groupId = groupOf.get(a.id);
      return {
        offeringId: a.offeringId,
        assignmentId: a.id,
        title: a.title,
        dueAt: a.dueAt,
        ...(groupId === undefined ? {} : { groupId }),
        pointsPossible: maxima.length === 0 ? null : Math.max(...maxima),
      };
    });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A counted cell's contribution: points earned and possible, and the percent it is worth. */
interface Counted {
  column: number;
  earned: number;
  possible: number;
  percent: number;
}

/** The latest official version of each student's grade for each assignment, by `assignment\u0000student`. */
function latestVersions(versions: readonly OfficialGradeVersion[]): Map<string, OfficialGradeVersion> {
  const latest = new Map<string, OfficialGradeVersion>();
  for (const version of versions) {
    const key = `${version.assignmentId}\u0000${version.studentPrincipalId}`;
    if ((latest.get(key)?.version ?? 0) < version.version) latest.set(key, version);
  }
  return latest;
}

/** Combines counted cells the way the settings say: points over points possible, or the mean percent. */
function combine(cells: readonly Counted[], calculation: GradebookSettings["calculation"]): number | null {
  if (cells.length === 0) return null;
  if (calculation === "percent") return cells.reduce((sum, c) => sum + c.percent, 0) / cells.length;
  const possible = cells.reduce((sum, c) => sum + c.possible, 0);
  return possible === 0 ? null : (cells.reduce((sum, c) => sum + c.earned, 0) / possible) * 100;
}

/** The cells a group keeps after dropping its `dropLowest` lowest percentages (the earlier column first on a tie), never all of them. */
function afterDrops(cells: readonly Counted[], dropLowest: number): { kept: Counted[]; dropped: Counted[] } {
  const drop = Math.min(dropLowest, cells.length - 1);
  if (drop <= 0) return { kept: [...cells], dropped: [] };
  const lowest = new Set(cells.toSorted((a, b) => a.percent - b.percent || a.column - b.column).slice(0, drop));
  return { kept: cells.filter((c) => !lowest.has(c)), dropped: [...lowest] };
}

/** The letter a final percentage earns on `scale`, or `null` without one. */
export function letterFor(percent: number | null, scale: GradeScale): string | null {
  if (percent === null) return null;
  const rounded = round(percent);
  return scale.find((cutoff) => rounded >= cutoff.minPercent)?.letter ?? null;
}

/**
 * Computes an offering's gradebook. Pure: the same input always gives the same output.
 *
 * - A cell shows the latest official grade version and nothing else.
 * - An excused cell counts toward nothing. An ungraded cell counts only if it is marked missing
 *   and the settings count missing work as zero: at 0% when combining by percent, or as zero out
 *   of the column's points possible when combining by points (and not at all before the column
 *   has any grade to take its points possible from).
 * - Each group drops its lowest counted scores, then combines what is left. The weighted total is
 *   taken over the groups with a weight and something counted, their weights scaled to add up to
 *   100. The unweighted total combines every kept score, grouped or not.
 */
export function computeGradebook(input: GradebookInput): ComputedGradebook {
  const { settings } = input;
  const columns = gradebookColumns(input);
  const latest = latestVersions(input.versions);
  const markers = new Map(input.markers.map((m) => [`${m.assignmentId}\u0000${m.studentPrincipalId}`, m.marker]));
  const columnIndex = new Map(columns.map((c, i) => [c.assignmentId, i]));

  const rows = input.students.map((student): GradebookRow => {
    const counted = new Map<number, Counted>();
    const cells = columns.map((column, index): GradebookCell => {
      const key = `${column.assignmentId}\u0000${student.principalId}`;
      const version = latest.get(key);
      const marker = markers.get(key);
      const base = {
        assignmentId: column.assignmentId,
        ...(version === undefined ? {} : { score: version.score, version: version.version }),
        ...(marker === undefined ? {} : { marker }),
      };
      if (version !== undefined) {
        const percent = (version.score.points / version.score.maxPoints) * 100;
        if (marker !== "excused") counted.set(index, { column: index, earned: version.score.points, possible: version.score.maxPoints, percent });
        return { ...base, percent: round(percent), counted: marker !== "excused", dropped: false };
      }
      const zero = marker === "missing" && settings.missing === "zero" && (settings.calculation === "percent" || column.pointsPossible !== null);
      if (zero) counted.set(index, { column: index, earned: 0, possible: column.pointsPossible ?? 0, percent: 0 });
      return { ...base, percent: zero ? 0 : null, counted: zero, dropped: false };
    });

    const dropped = new Set<number>();
    const groups = settings.groups.map((group) => {
      const inGroup = group.assignmentIds
        .map((id) => columnIndex.get(id))
        .filter((i): i is number => i !== undefined)
        .flatMap((i) => counted.get(i) ?? [])
        .toSorted((a, b) => a.column - b.column);
      const { kept, dropped: lowest } = afterDrops(inGroup, group.dropLowest);
      for (const cell of lowest) dropped.add(cell.column);
      return { group, percent: combine(kept, settings.calculation) };
    });

    const kept = [...counted.values()].filter((c) => !dropped.has(c.column)).toSorted((a, b) => a.column - b.column);
    const unweighted = combine(kept, settings.calculation);
    const weightedGroups = groups.filter((g) => g.group.weight > 0 && g.percent !== null);
    const weightSum = weightedGroups.reduce((sum, g) => sum + g.group.weight, 0);
    const weighted = weightSum === 0 ? null : weightedGroups.reduce((sum, g) => sum + g.group.weight * g.percent!, 0) / weightSum;
    const final = settings.weighting === "group-weights" ? weighted : unweighted;

    return {
      studentPrincipalId: student.principalId,
      displayName: student.displayName,
      cells: cells.map((cell, index) => (dropped.has(index) ? { ...cell, counted: false, dropped: true } : cell)),
      groups: groups.map(({ group, percent }) => ({ groupId: group.id, percent: percent === null ? null : round(percent) })),
      totals: {
        points: { earned: round(kept.reduce((sum, c) => sum + c.earned, 0)), possible: round(kept.reduce((sum, c) => sum + c.possible, 0)) },
        unweighted: unweighted === null ? null : round(unweighted),
        weighted: weighted === null ? null : round(weighted),
        final: final === null ? null : round(final),
        letter: letterFor(final, settings.scale),
      },
    };
  });

  return { columns, rows };
}

// CSV export

const MARKER_TEXT: Record<GradeMarker, string> = { excused: "EX", missing: "MISSING", late: "LATE" };

/**
 * One CSV field: a cell a spreadsheet would read as a formula (one starting with `=`, `+`, `-`, `@`,
 * a tab or a carriage return) gets a leading `'`, so an assignment title or a name can never run
 * as one; then, per RFC 4180, a field holding a quote, comma or line break is quoted with its
 * quotes doubled.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function percentText(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

function cellText(cell: GradebookCell): string {
  if (cell.marker === "excused") return MARKER_TEXT.excused;
  if (cell.score !== undefined) return String(cell.score.points);
  return cell.marker === undefined ? "" : MARKER_TEXT[cell.marker];
}

/**
 * The gradebook as RFC 4180 CSV, with CRLF line ends: a header row, then one row per student in
 * the gradebook's row order. Columns are the student's name and ID, each assignment in column
 * order (its latest official points, or `EX`, `MISSING` or `LATE` for an ungraded marked cell),
 * each group's percentage in settings order, then the points earned and possible and the
 * unweighted, weighted and final percentages and the letter.
 */
export function gradebookCsv(gradebook: ComputedGradebook, settings: GradebookSettings): string {
  const header = [
    "Student",
    "Student ID",
    ...gradebook.columns.map((c) => (c.pointsPossible === null ? c.title : `${c.title} (${c.pointsPossible} pts)`)),
    ...settings.groups.map((g) => `${g.name} %`),
    "Points earned",
    "Points possible",
    "Unweighted %",
    "Weighted %",
    "Final %",
    "Letter",
  ];
  const rows = gradebook.rows.map((row) => [
    row.displayName,
    row.studentPrincipalId,
    ...row.cells.map(cellText),
    ...row.groups.map((g) => percentText(g.percent)),
    String(row.totals.points.earned),
    String(row.totals.points.possible),
    percentText(row.totals.unweighted),
    percentText(row.totals.weighted),
    percentText(row.totals.final),
    row.totals.letter ?? "",
  ]);
  return [header, ...rows].map((fields) => fields.map(csvField).join(",")).join("\r\n") + "\r\n";
}
