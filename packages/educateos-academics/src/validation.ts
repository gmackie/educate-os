import {
  checkDirectoryIntegrity,
  DistrictDirectorySnapshot,
  EducateOsError,
  type DirectoryIssue,
  type TermState,
} from "@educateos/contracts";
import type { z } from "zod";

const MAX_MESSAGE_LENGTH = 1000;

/**
 * A `validation-failed` error that also carries the individual issues, for callers that want them
 * structured. The issues are listed in the message too, since that is all the error body carries.
 */
export class DirectoryValidationError extends EducateOsError {
  /** Every problem found, not only the first. */
  readonly issues: DirectoryIssue[];

  constructor(summary: string, issues: DirectoryIssue[]) {
    const listed = `${summary}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
    super(
      "validation-failed",
      listed.length > MAX_MESSAGE_LENGTH ? `${listed.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : listed,
    );
    this.name = "DirectoryValidationError";
    this.issues = issues;
  }
}

/** Converts a Zod failure into directory issues, with dotted paths. */
export function zodIssues(error: z.ZodError): DirectoryIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(input)" : issue.path.map(String).join("."),
    message: issue.message,
  }));
}

/**
 * Parses a whole directory and runs `checkDirectoryIntegrity` on it, throwing every issue found.
 * Every write and every seed passes through here before it is committed, so the stored directory
 * always satisfies both.
 */
export function validateDirectory(input: unknown): DistrictDirectorySnapshot {
  const parsed = DistrictDirectorySnapshot.safeParse(input);
  if (!parsed.success) throw new DirectoryValidationError("the directory change is invalid", zodIssues(parsed.error));
  const issues = checkDirectoryIntegrity(parsed.data);
  if (issues.length > 0) throw new DirectoryValidationError("the directory change is inconsistent", issues);
  return parsed.data;
}

/**
 * The one state each term state may move to. Terms only move forward, one step at a time: a
 * completed term's work is retained, and reopening it would re-grant live access that was
 * deliberately removed at close.
 */
export const NEXT_TERM_STATE: Readonly<Record<TermState, TermState | undefined>> = {
  planned: "active",
  active: "grading",
  grading: "completed",
  completed: undefined,
};

/** Refuses any term state change other than the single next step. */
export function assertTermTransition(from: TermState, to: TermState): void {
  if (NEXT_TERM_STATE[from] === to) return;
  const next = NEXT_TERM_STATE[from];
  throw new EducateOsError(
    "conflict",
    next === undefined
      ? `A ${from} term cannot change state.`
      : `A ${from} term can only move to ${next}, not ${to}.`,
  );
}
