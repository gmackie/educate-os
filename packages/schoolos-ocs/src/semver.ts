import { z } from "zod";

/**
 * A package version: `MAJOR.MINOR.PATCH` with no leading zeros. OCS 1.0 has no pre-release or
 * build suffixes (RFC 0001, open question 3), so every version is a release a teacher can pick.
 */
export const SemVer = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/, "expected a version such as 1.2.0");
/** A package version. */
export type SemVer = z.infer<typeof SemVer>;

type Triple = readonly [number, number, number];

const parseTriple = (version: string): Triple => {
  const [major, minor, patch] = version.split(".").map(Number);
  return [major!, minor!, patch!];
};

/** Orders two versions: negative if `a` is older, positive if newer, zero if equal. */
export function compareVersions(a: SemVer, b: SemVer): number {
  const x = parseTriple(a);
  const y = parseTriple(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

type Operator = ">=" | ">" | "<=" | "<" | "=";
interface Comparator {
  operator: Operator;
  version: SemVer;
}

const CORE = String.raw`(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})`;
const TERM = new RegExp(`^(\\^|~|>=|<=|>|<|=)?(${CORE})$`);

const format = ([major, minor, patch]: Triple): SemVer => `${major}.${minor}.${patch}`;

/** The comparators one range term stands for, or undefined if it is not a term. */
function termComparators(term: string): Comparator[] | undefined {
  const match = TERM.exec(term);
  if (match === null) return undefined;
  const operator = match[1] ?? "=";
  const version = match[2]!;
  const [major, minor, patch] = parseTriple(version);
  switch (operator) {
    case "^": {
      // The npm caret: changes that keep the leftmost non-zero component are compatible.
      const upper: Triple = major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
      return [{ operator: ">=", version }, { operator: "<", version: format(upper) }];
    }
    case "~":
      return [{ operator: ">=", version }, { operator: "<", version: format([major, minor + 1, 0]) }];
    default:
      return [{ operator: operator as Operator, version }];
  }
}

function rangeComparators(range: string): Comparator[] | undefined {
  const terms = range.trim().split(/\s+/);
  const comparators: Comparator[] = [];
  for (const term of terms) {
    const parsed = termComparators(term);
    if (parsed === undefined) return undefined;
    comparators.push(...parsed);
  }
  return comparators;
}

/**
 * A version range: one or more space-separated terms that must all hold. A term is an exact
 * version (`1.2.0`), a caret range (`^1.2.0`: compatible with 1.2.0), a tilde range (`~1.2.0`:
 * patch updates of 1.2) or a comparison (`>=1.2.0`, `<2.0.0`). There is no `||` and no wildcard,
 * so a range always reads as one interval.
 */
export const VersionRange = z
  .string()
  .min(1)
  .max(100)
  .refine((range) => rangeComparators(range) !== undefined, "expected a version range such as ^1.2.0");
/** A version range. */
export type VersionRange = z.infer<typeof VersionRange>;

const holds = (version: SemVer, { operator, version: bound }: Comparator): boolean => {
  const order = compareVersions(version, bound);
  switch (operator) {
    case ">=":
      return order >= 0;
    case ">":
      return order > 0;
    case "<=":
      return order <= 0;
    case "<":
      return order < 0;
    case "=":
      return order === 0;
  }
};

/** Whether a version is within a range. */
export function satisfies(version: SemVer, range: VersionRange): boolean {
  const comparators = rangeComparators(range);
  if (comparators === undefined) throw new Error(`not a version range: ${range}`);
  return comparators.every((comparator) => holds(version, comparator));
}

/** Whether a range admits exactly one version, so a digest can pin it. */
export function isExactRange(range: VersionRange): boolean {
  return SemVer.safeParse(range.trim().replace(/^=/, "")).success;
}

/** What a published change does to the people who use the package, and so which component it bumps. */
export const ChangeKind = z.enum([
  /** Corrections only: typos, a broken link replaced. Bumps the patch version. */
  "fix",
  /** New or reworked material that keeps what was there. Bumps the minor version. */
  "addition",
  /** Units or activities removed or renamed in ways that change the course. Bumps the major version. */
  "major-change",
]);
/** A change kind. */
export type ChangeKind = z.infer<typeof ChangeKind>;

/** The version after `version` for a change of the given kind. */
export function nextVersion(version: SemVer, change: ChangeKind): SemVer {
  const [major, minor, patch] = parseTriple(version);
  switch (change) {
    case "fix":
      return format([major, minor, patch + 1]);
    case "addition":
      return format([major, minor + 1, 0]);
    case "major-change":
      return format([major + 1, 0, 0]);
  }
}
