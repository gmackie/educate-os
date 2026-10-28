// Normalize the licensed Classroom response surface. Provider fields outside these types never
// cross the capability boundary, and malformed required fields fail instead of inventing values.
import type {
  ClassroomRubricUpdate, ClassroomGradingPeriodUpdate, ClassroomDate, ClassroomGradingPeriodSettings, ClassroomRubric, ClassroomRubricCriterion,
  ClassroomRubricDraft,
} from "./classroom-types";

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Classroom Plus response.");
  return value as Raw;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > 30_000) throw new Error("Classroom rubric text is missing or too long.");
  return value;
};
const optionalText = (value: unknown): { description?: string } => value === undefined ? {} : { description: text(value) };
const identifier = (value: unknown): { id?: string } => value === undefined ? {} : { id: text(value) };

function criteria(value: unknown, includeIds: boolean): ClassroomRubricCriterion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error("A Classroom rubric needs 1 to 50 criteria.");
  return value.map(value => {
    const criterion = record(value);
    if (!Array.isArray(criterion.levels) || criterion.levels.length === 0 || criterion.levels.length > 10) {
      throw new Error("A Classroom criterion needs 1 to 10 levels.");
    }
    return {
      ...(includeIds ? identifier(criterion.id) : {}), title: text(criterion.title), ...optionalText(criterion.description),
      levels: criterion.levels.map(value => {
        const level = record(value);
        if (level.points !== undefined && (typeof level.points !== "number" || !Number.isFinite(level.points) || level.points < 0)) {
          throw new Error("Classroom rubric points must be finite and non-negative.");
        }
        return { ...(includeIds ? identifier(level.id) : {}), title: text(level.title), ...optionalText(level.description),
          ...(typeof level.points === "number" ? { points: level.points } : {}) };
      }),
    };
  });
}

/** Validate a draft and strip fields the caller cannot set, including provider-generated IDs. */
export function classroomRubricDraft(value: ClassroomRubricDraft): ClassroomRubricDraft {
  return { criteria: criteria(record(value).criteria, false) };
}

/** A rubric response, containing only the agent's declared fields. */
export function classroomRubricFromRaw(value: unknown): ClassroomRubric {
  const raw = record(value);
  return { id: text(raw.id), criteria: criteria(raw.criteria, true) };
}

function date(value: unknown): ClassroomDate {
  const raw = record(value);
  const { year, month, day } = raw;
  if (typeof year !== "number" || typeof month !== "number" || typeof day !== "number" ||
      !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 1 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error("Malformed Classroom grading period date.");
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) {
    throw new Error("Malformed Classroom grading period date.");
  }
  return { year, month, day };
}

/** Grading-period settings; an empty object means the course has no periods configured. */
export function classroomGradingPeriodsFromRaw(value: unknown): ClassroomGradingPeriodSettings {
  const raw = record(value);
  if (raw.gradingPeriods !== undefined && !Array.isArray(raw.gradingPeriods)) throw new Error("Malformed Classroom grading periods.");
  if (raw.applyToExistingCoursework !== undefined && typeof raw.applyToExistingCoursework !== "boolean") throw new Error("Malformed Classroom grading period settings.");
  return {
    gradingPeriods: (raw.gradingPeriods ?? []).map((value: unknown) => {
      const period = record(value);
      return { id: text(period.id), title: text(period.title), startDate: date(period.startDate), endDate: date(period.endDate) };
    }),
    ...(typeof raw.applyToExistingCoursework === "boolean" ? { applyToExistingCoursework: raw.applyToExistingCoursework } : {}),
  };
}

/** Validate replacement criteria while retaining existing provider IDs. */
export function classroomRubricUpdate(value: ClassroomRubricUpdate): ClassroomRubricUpdate {
  return { criteria: criteria(record(value).criteria, true) };
}

/** Validate a complete, chronological, non-overlapping period replacement before any request. */
export function classroomGradingPeriodUpdate(value: ClassroomGradingPeriodUpdate): ClassroomGradingPeriodUpdate {
  const raw = record(value);
  if (!Array.isArray(raw.gradingPeriods) || raw.gradingPeriods.length > 100 || typeof raw.applyToExistingCoursework !== "boolean") {
    throw new Error("A grading-period replacement needs periods and an explicit applyToExistingCoursework choice.");
  }
  const titles = new Set<string>();
  const ids = new Set<string>();
  let previousEnd = "";
  const key = (d: ClassroomDate) => [d.year.toString().padStart(4, "0"), d.month.toString().padStart(2, "0"), d.day.toString().padStart(2, "0")].join("-");
  const gradingPeriods = raw.gradingPeriods.map(value => {
    const period = record(value);
    const title = text(period.title).trim();
    const startDate = date(period.startDate), endDate = date(period.endDate);
    const id = identifier(period.id);
    if (titles.has(title) || key(startDate) > key(endDate) || key(startDate) <= previousEnd || (id.id !== undefined && ids.has(id.id))) {
      throw new Error("Grading periods require unique titles/IDs and chronological non-overlapping dates.");
    }
    titles.add(title);
    if (id.id !== undefined) ids.add(id.id);
    previousEnd = key(endDate);
    return { ...id, title, startDate, endDate };
  });
  return { gradingPeriods, applyToExistingCoursework: raw.applyToExistingCoursework };
}
