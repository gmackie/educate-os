import { EducateOsError, SemVer } from "@educateos/contracts";

/**
 * Compares two semantic versions by SemVer 2.0 precedence: negative if `a` is older, positive if
 * newer, 0 if equal. A pre-release (`1.0.0-rc.1`) is older than its release (`1.0.0`). Build
 * metadata is not part of {@link SemVer}, so it never arises.
 */
export function compareSemVer(a: string, b: string): number {
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const difference = coreA[i]! - coreB[i]!;
    if (difference !== 0) return Math.sign(difference);
  }
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split(".");
  const partsB = preB.split(".");
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    const order = compareIdentifier(partsA[i]!, partsB[i]!);
    if (order !== 0) return order;
  }
  return Math.sign(partsA.length - partsB.length);
}

function split(version: string): [number[], string | undefined] {
  if (!SemVer.safeParse(version).success) throw new EducateOsError("validation-failed", "expected a semantic version");
  const dash = version.indexOf("-");
  const core = dash === -1 ? version : version.slice(0, dash);
  return [core.split(".").map(Number), dash === -1 ? undefined : version.slice(dash + 1)];
}

// Numeric identifiers compare numerically and sort before alphanumeric ones, which compare as
// ASCII (SemVer 2.0 §11).
function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a);
  const numericB = /^\d+$/.test(b);
  if (numericA && numericB) return Math.sign(Number(a) - Number(b));
  if (numericA !== numericB) return numericA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
