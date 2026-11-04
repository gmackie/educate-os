import { type ErrorCode, EducateOsError } from "@educateos/contracts";

/** One problem found in a package's files. */
export interface PackageIssue {
  /** The file and field, such as `units/cells.json: items.2.ref`. */
  path: string;
  message: string;
}

/** One module's requirement on a package, as a version conflict reports it. */
export interface VersionRequirement {
  /** The package that asked, as `id@version`, or `id` for the course being composed. */
  requiredBy: string;
  range: string;
}

/**
 * Why reading, resolving or composing a course failed. Each kind carries what a teacher-facing
 * UI needs to explain the failure without showing package internals.
 */
export type OcsProblem =
  | { kind: "invalid-package"; packageId?: string; issues: PackageIssue[] }
  | { kind: "unknown-package"; packageId: string; version?: string }
  | { kind: "version-conflict"; packageId: string; requirements: VersionRequirement[]; available: string[] }
  | { kind: "cycle"; path: string[] }
  | { kind: "digest-mismatch"; packageId: string; version: string; expected: string; actual: string }
  | { kind: "identity-mismatch"; packageId: string; version: string; found: string }
  | { kind: "invalid-change"; packageId: string; target: string; reason: string }
  /** An activity export's file is not a valid export (OCS 1.1). */
  | { kind: "invalid-export"; exportId?: string; issues: PackageIssue[] }
  /** No source holds the export version a portable activity names. */
  | { kind: "unknown-export"; exportId: string; version: string }
  /** An export's content is not the content its reference or publication recorded, or it is another export. */
  | { kind: "export-mismatch"; exportId: string; version: string; reason: string }
  /** A portable activity the destination has not imported, so it has no local definition to install. */
  | { kind: "unmapped-activity"; itemKey: string; exportId: string; version: string };

const CODES: Record<OcsProblem["kind"], ErrorCode> = {
  "invalid-package": "validation-failed",
  "unknown-package": "not-found",
  "version-conflict": "conflict",
  cycle: "validation-failed",
  "digest-mismatch": "validation-failed",
  "identity-mismatch": "validation-failed",
  "invalid-change": "validation-failed",
  "invalid-export": "validation-failed",
  "unknown-export": "not-found",
  "export-mismatch": "validation-failed",
  "unmapped-activity": "conflict",
};

const MAX_LISTED_ISSUES = 5;

/** A message for a problem in plain words, for teachers as much as for logs. */
export function describeProblem(problem: OcsProblem): string {
  switch (problem.kind) {
    case "invalid-package": {
      const listed = problem.issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `${issue.path}: ${issue.message}`);
      const more = problem.issues.length > MAX_LISTED_ISSUES ? ` (and ${problem.issues.length - MAX_LISTED_ISSUES} more)` : "";
      return `${problem.packageId ?? "The course package"} is not a valid course package: ${listed.join("; ")}${more}`;
    }
    case "unknown-package":
      return problem.version === undefined
        ? `No published versions of ${problem.packageId} are available.`
        : `Version ${problem.version} of ${problem.packageId} is not available.`;
    case "version-conflict": {
      const needs = problem.requirements.map((r) => `${r.requiredBy} needs ${r.range}`).join(", ");
      const available = problem.available.length === 0 ? "none" : problem.available.join(", ");
      return `No version of ${problem.packageId} fits every module that uses it: ${needs}. Available versions: ${available}.`;
    }
    case "cycle":
      return `These modules include each other in a loop, so the course cannot be put together: ${problem.path.join(" -> ")}.`;
    case "digest-mismatch":
      return `The content of ${problem.packageId} ${problem.version} does not match its recorded fingerprint (expected ${problem.expected}, found ${problem.actual}); it was changed after it was published, so it will not be used.`;
    case "identity-mismatch":
      return `The package offered as ${problem.packageId} ${problem.version} is actually ${problem.found}, so it will not be used.`;
    case "invalid-change":
      return `A change made in ${problem.packageId} to ${problem.target} cannot be applied: ${problem.reason}.`;
    case "invalid-export": {
      const listed = problem.issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `${issue.path}: ${issue.message}`);
      const more = problem.issues.length > MAX_LISTED_ISSUES ? ` (and ${problem.issues.length - MAX_LISTED_ISSUES} more)` : "";
      return `${problem.exportId ?? "The activity"} is not a valid shared activity: ${listed.join("; ")}${more}`;
    }
    case "unknown-export":
      return `Version ${problem.version} of the shared activity ${problem.exportId} is not available.`;
    case "export-mismatch":
      return `The shared activity ${problem.exportId} ${problem.version} will not be used: ${problem.reason}.`;
    case "unmapped-activity":
      return `${problem.itemKey} uses the shared activity ${problem.exportId} ${problem.version}, which has not been imported into this district yet.`;
  }
}

/** A {@link EducateOsError} that also carries the structured {@link OcsProblem}. */
export class OcsError extends EducateOsError {
  /** What went wrong, structured. */
  readonly problem: OcsProblem;

  constructor(problem: OcsProblem) {
    super(CODES[problem.kind], describeProblem(problem));
    this.problem = problem;
  }
}
