// Immutable district-owned Curriculum CI history. No assessment or student data.
// These are *historical* check results, not transferable publication approvals.
import { EducateOsError } from "@educateos/contracts";
import { CourseQualityRunBody, type CourseQualityRun } from "./routes.ts";

export interface CourseQualityRunStore {
  /**
   * Append exactly once per (offering, requester, idempotency key).
   * A replay with the same source, report and policy snapshot returns the original;
   * different content under the same key is a conflict. No overwrite/delete API.
   */
  append(run: CourseQualityRun): Promise<CourseQualityRun>;
  get(offeringId: string, runId: string): Promise<CourseQualityRun | undefined>;
  /** Newest first; bounded independently of the number of runs retained. */
  list(offeringId: string, limit?: number): Promise<CourseQualityRun[]>;
}

function sameRequest(a: CourseQualityRun, b: CourseQualityRun): boolean {
  return a.offeringId === b.offeringId
    && a.requestedBy === b.requestedBy
    && a.requestKey === b.requestKey
    && a.checkVersion === b.checkVersion
    && a.reportFingerprint === b.reportFingerprint
    && a.context.standardsDecisionDigest === b.context.standardsDecisionDigest
    && a.context.districtSettingsDigest === b.context.districtSettingsDigest
    && a.context.configRevisionId === b.context.configRevisionId
    && a.report.packageId === b.report.packageId
    && a.report.version === b.report.version
    && a.report.digest === b.report.digest;
}

export function checkedReplay(existing: CourseQualityRun, candidate: CourseQualityRun): CourseQualityRun {
  if (!sameRequest(existing, candidate)) {
    throw new EducateOsError("conflict",
      "This quality run request key was already used for different course or evaluation context.");
  }
  return existing;
}

/** Hash a canonicalizable, bounded metadata value without sending it outside the district. */
export async function qualityFingerprint(value: unknown): Promise<string> {
  const canon = JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : v);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class InMemoryCourseQualityRunStore implements CourseQualityRunStore {
  readonly #runs: CourseQualityRun[] = [];

  async append(input: CourseQualityRun): Promise<CourseQualityRun> {
    const run = CourseQualityRunBody.parse(input);
    const old = this.#runs.find((candidate) => candidate.offeringId === run.offeringId
      && candidate.requestedBy === run.requestedBy && candidate.requestKey === run.requestKey);
    if (old !== undefined) return structuredClone(checkedReplay(old, run));
    if (this.#runs.some((candidate) => candidate.id === run.id)) {
      throw new EducateOsError("conflict", "That quality run identifier has already been used.");
    }
    this.#runs.push(structuredClone(run));
    return structuredClone(run);
  }

  async get(offeringId: string, runId: string): Promise<CourseQualityRun | undefined> {
    const found = this.#runs.find((run) => run.id === runId && run.offeringId === offeringId);
    return found === undefined ? undefined : structuredClone(found);
  }

  async list(offeringId: string, limit = 25): Promise<CourseQualityRun[]> {
    return structuredClone(this.#runs.filter((run) => run.offeringId === offeringId).slice(-limit).reverse());
  }
}
