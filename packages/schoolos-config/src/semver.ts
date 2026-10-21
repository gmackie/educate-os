// A deliberately small semantic-version matcher. Manifests pin dependencies with exact, caret or
// tilde ranges only; anything else is rejected rather than half-understood.

/** A parsed semantic version. */
export interface ParsedVersion {
  /** Major version. */
  major: number;
  /** Minor version. */
  minor: number;
  /** Patch version. */
  patch: number;
  /** Dot-separated prerelease identifiers, empty for a release. */
  prerelease: readonly string[];
}

/** The operators a version range may use: none (exact), caret or tilde. */
export type RangeOperator = "exact" | "^" | "~";

/** A parsed version range. */
export interface ParsedRange {
  /** The range operator. */
  operator: RangeOperator;
  /** The version the range is anchored on. */
  base: ParsedVersion;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parses `1.4.0` or `0.2.0-beta.1`, or returns `undefined` for anything else. */
export function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION.exec(text);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Parses `1.2.3`, `^1.2.3` or `~1.2.3`, or returns `undefined` for any other range syntax. */
export function parseRange(text: string): ParsedRange | undefined {
  const operator: RangeOperator = text.startsWith("^") ? "^" : text.startsWith("~") ? "~" : "exact";
  const base = parseVersion(operator === "exact" ? text : text.slice(1));
  return base === undefined ? undefined : { operator, base };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  // Numeric identifiers sort before alphanumeric ones (SemVer 2.0.0 §11.4.3).
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders two versions by SemVer precedence: negative, zero or positive. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // A release outranks any of its prereleases.
    return b.prerelease.length - a.prerelease.length;
  }
  for (let i = 0; i < Math.min(a.prerelease.length, b.prerelease.length); i++) {
    const order = compareIdentifiers(a.prerelease[i]!, b.prerelease[i]!);
    if (order !== 0) return order;
  }
  return a.prerelease.length - b.prerelease.length;
}

/** The exclusive upper bound of a caret or tilde range. */
function upperBound({ operator, base }: ParsedRange): ParsedVersion {
  if (operator === "~") return { major: base.major, minor: base.minor + 1, patch: 0, prerelease: [] };
  // Caret allows changes that do not modify the left-most non-zero component.
  if (base.major > 0) return { major: base.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (base.minor > 0) return { major: 0, minor: base.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: base.patch + 1, prerelease: [] };
}

/**
 * Whether `version` satisfies `range`. Ranges follow npm's semantics for `^` and `~`, including the
 * stricter caret on `0.x` versions. A prerelease only satisfies a range anchored on a prerelease of
 * the same `major.minor.patch`, so `^1.0.0` never silently accepts `1.1.0-beta.1`.
 *
 * Returns `undefined` when either string cannot be parsed, so callers can report a bad range
 * rather than treating it as a mismatch.
 */
export function satisfies(version: string, range: string): boolean | undefined {
  const parsedVersion = parseVersion(version);
  const parsedRange = parseRange(range);
  if (parsedVersion === undefined || parsedRange === undefined) return undefined;
  const { base } = parsedRange;
  if (parsedRange.operator === "exact") return compareVersions(parsedVersion, base) === 0;
  if (parsedVersion.prerelease.length > 0) {
    const sameCore = parsedVersion.major === base.major && parsedVersion.minor === base.minor
      && parsedVersion.patch === base.patch;
    if (!sameCore || base.prerelease.length === 0) return false;
  }
  return compareVersions(parsedVersion, base) >= 0
    && compareVersions(parsedVersion, upperBound(parsedRange)) < 0;
}
