// The rules of the dependency vulnerability scan (SCHO-375, docs/educateos/security/dependency-scanning.md).
// Pure functions, so the gate's decisions are unit-tested without the registry; the CLI in
// `dependency-audit.ts` runs `pnpm audit` and feeds them.

/** pnpm audit's severities, lowest first. */
export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The severities that gate: a new one of these in a production dependency fails a pull request. */
export const GATING: ReadonlySet<Severity> = new Set(["high", "critical"]);

/** One advisory from `pnpm audit --json`, reduced to what the gate reads. */
export interface Advisory {
  /** The GitHub advisory ID, for example `GHSA-xxxx-xxxx-xxxx`. */
  id: string;
  /** The vulnerable package's name. */
  module: string;
  severity: Severity;
  /** The installed versions the advisory matches. */
  versions: string[];
  /** The ranges that fix it, as pnpm reports them. */
  patched: string;
  title: string;
  url: string;
  /** One dependency path to the package, to say where it comes from. */
  path: string;
}

/** One accepted, already-triaged advisory in the checked-in baseline. */
export interface BaselineEntry {
  /** The GitHub advisory ID. */
  id: string;
  /** The lockfile it applies to, relative to the repository root. */
  lockfile: string;
  package: string;
  severity: Severity;
  /** The advisory's title, for a reader of the file. */
  title?: string;
  /** Why it is accepted for now: reachability, exposure, what blocks the upgrade. */
  reason: string;
  /** The Kanbanger issue that tracks the upgrade, for example `SCHO-376`. */
  issue?: string;
  /** The date (YYYY-MM-DD) after which the entry no longer suppresses the advisory. */
  expires?: string;
}

/** The shape `pnpm audit --json` prints, enough to read advisories from. */
interface RawAudit {
  advisories: Record<string, {
    github_advisory_id?: unknown;
    module_name?: unknown;
    severity?: unknown;
    patched_versions?: unknown;
    title?: unknown;
    url?: unknown;
    findings?: Array<{ version?: unknown; paths?: unknown }>;
  }>;
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Reads `pnpm audit --json` output. Throws when it is not an audit report (a registry error, a
 * network failure, a changed format), so the caller can tell "no data" from "no advisories".
 */
export function parseAudit(text: string): Advisory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`pnpm audit printed no JSON report: ${text.trim().slice(0, 300) || "(empty)"}`);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as RawAudit).advisories !== "object") {
    throw new Error(`pnpm audit printed no advisories: ${text.trim().slice(0, 300)}`);
  }
  const advisories: Advisory[] = [];
  for (const [key, raw] of Object.entries((parsed as RawAudit).advisories)) {
    if (!isSeverity(raw.severity) || typeof raw.module_name !== "string") {
      throw new Error(`pnpm audit advisory ${key} has an unexpected shape`);
    }
    const findings = Array.isArray(raw.findings) ? raw.findings : [];
    const versions = [...new Set(findings.map(f => f.version).filter((v): v is string => typeof v === "string"))];
    const firstPaths = findings.find(f => Array.isArray(f.paths) && f.paths.length > 0)?.paths as string[] | undefined;
    advisories.push({
      id: typeof raw.github_advisory_id === "string" ? raw.github_advisory_id : key,
      module: raw.module_name,
      severity: raw.severity,
      versions,
      patched: typeof raw.patched_versions === "string" ? raw.patched_versions : "",
      title: typeof raw.title === "string" ? raw.title : "",
      url: typeof raw.url === "string" ? raw.url : "",
      path: firstPaths?.[0] ?? "",
    });
  }
  return advisories;
}

/** Advisory counts by severity, every severity present. */
export function countBySeverity(advisories: readonly Advisory[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map(s => [s, 0])) as Record<Severity, number>;
  for (const a of advisories) counts[a.severity] += 1;
  return counts;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE = /^[A-Z][A-Z0-9]*-\d+$/;

/** Validates the baseline file's contents. Every problem is returned; an empty list means valid. */
export function validateBaseline(raw: unknown): { entries: BaselineEntry[]; errors: string[] } {
  const errors: string[] = [];
  const list = (raw as { advisories?: unknown } | null)?.advisories;
  if (!Array.isArray(list)) return { entries: [], errors: ["the baseline must be an object with an `advisories` array"] };
  const entries: BaselineEntry[] = [];
  const seen = new Set<string>();
  list.forEach((value: unknown, index) => {
    const e = value as Partial<Record<keyof BaselineEntry, unknown>>;
    const where = `baseline entry ${index}${typeof e?.id === "string" ? ` (${e.id})` : ""}`;
    const problems: string[] = [];
    if (typeof e?.id !== "string" || !e.id.startsWith("GHSA-")) problems.push("`id` must be a GHSA advisory ID");
    if (typeof e?.lockfile !== "string" || !e.lockfile.endsWith("pnpm-lock.yaml")) problems.push("`lockfile` must name a pnpm-lock.yaml");
    if (typeof e?.package !== "string" || e.package === "") problems.push("`package` is required");
    if (!isSeverity(e?.severity)) problems.push("`severity` must be one of " + SEVERITIES.join(", "));
    if (typeof e?.reason !== "string" || e.reason.trim().length < 20) problems.push("`reason` must say why the advisory is accepted");
    if (e?.issue !== undefined && (typeof e.issue !== "string" || !ISSUE.test(e.issue))) problems.push("`issue` must be an issue key such as SCHO-123");
    if (e?.expires !== undefined && (typeof e.expires !== "string" || !DATE.test(e.expires))) problems.push("`expires` must be a YYYY-MM-DD date");
    if (e?.issue === undefined && e?.expires === undefined) problems.push("give an `issue`, an `expires` date, or both");
    if (problems.length > 0) {
      errors.push(`${where}: ${problems.join("; ")}`);
      return;
    }
    const entry = e as BaselineEntry;
    const key = `${entry.lockfile} ${entry.id}`;
    if (seen.has(key)) errors.push(`${where}: duplicate entry for ${entry.lockfile}`);
    seen.add(key);
    entries.push(entry);
  });
  return { entries, errors };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a pnpm v9 lockfile's text resolves `name@version` (a `packages:` or `snapshots:` key). */
export function lockfileHas(lockText: string, name: string, version: string): boolean {
  const key = new RegExp(`^ {2}'?${escapeRegExp(name)}@${escapeRegExp(version)}(?:['(:])`, "m");
  return key.test(lockText);
}

/** What the gate decided for one lockfile. */
export interface Evaluation {
  /** Fail the job: a new gating advisory in production dependencies. */
  errors: string[];
  /** Report, never fail: accepted-but-expired or pre-existing unbaselined gating advisories. */
  warnings: string[];
  /** Housekeeping: baseline entries the audit no longer reports. */
  notices: string[];
}

/** The inputs for {@link evaluate}. */
export interface EvaluateInput {
  /** The lockfile, relative to the repository root. */
  lockfile: string;
  /** Advisories in production dependencies (`pnpm audit --prod`). */
  prod: readonly Advisory[];
  /** Every advisory (`pnpm audit`), for the stale-entry check. */
  all: readonly Advisory[];
  baseline: readonly BaselineEntry[];
  /** Today's date, YYYY-MM-DD. */
  today: string;
  /**
   * The base branch's copy of this lockfile, when gating a pull request. `null` means the base has
   * no such lockfile, so everything in it is new. `undefined` means report-only (main, nightly).
   */
  baseLock?: string | null;
}

function describe(a: Advisory, lockfile: string): string {
  const fix = a.patched ? `, fixed in ${a.patched}` : "";
  return `${a.severity} ${a.id} in ${a.module}@${a.versions.join(", ")} (${lockfile}${a.path ? `, via ${a.path}` : ""}${fix}): ${a.title} ${a.url}`.trim();
}

/** Applies the gating policy to one lockfile's audit. */
export function evaluate(input: EvaluateInput): Evaluation {
  const { lockfile, prod, all, baseline, today, baseLock } = input;
  const out: Evaluation = { errors: [], warnings: [], notices: [] };
  const entries = new Map(baseline.filter(e => e.lockfile === lockfile).map(e => [e.id, e]));

  for (const a of prod) {
    if (!GATING.has(a.severity)) continue;
    const entry = entries.get(a.id);
    if (entry && (entry.expires === undefined || entry.expires >= today)) continue;
    const expired = entry ? ` Its baseline entry expired on ${entry.expires}; re-triage it${entry.issue ? ` (${entry.issue})` : ""}.` : "";
    const introduced = baseLock !== undefined
      && a.versions.some(v => baseLock === null || !lockfileHas(baseLock, a.module, v));
    if (introduced) {
      out.errors.push(`New ${describe(a, lockfile)}. Upgrade or override the package, or add a baseline entry with a reason and an issue.${expired}`);
    } else {
      out.warnings.push(`Unbaselined ${describe(a, lockfile)}. It is already on the base branch, so it does not fail the job; file an issue and add a baseline entry, or upgrade.${expired}`);
    }
  }

  const reported = new Set(all.map(a => a.id));
  for (const entry of entries.values()) {
    if (!reported.has(entry.id)) {
      out.notices.push(`Baseline entry ${entry.id} (${entry.package}, ${lockfile}) is no longer reported by pnpm audit; remove it.`);
    }
  }
  return out;
}
