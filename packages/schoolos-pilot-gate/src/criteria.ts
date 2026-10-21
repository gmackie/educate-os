// The pilot gate's criteria registry: every roadmap §14 row, every §3.4 exit criterion and the H01
// additions, each with the checks that exercise it. The test files register their tests from this
// table (a check they do not implement fails at collection), the traceability table in
// docs/schoolos/pilot-gate.md is rendered from it, and the gate report joins it with a test run.
// Nothing about a criterion is written down twice.
import { z } from "zod";

/** A release gate (roadmap §12). */
export const Gate = z.enum(["G0", "G1", "G2", "G3", "G4"]);
/** A release gate. */
export type Gate = z.infer<typeof Gate>;

/** Where in the roadmap a criterion comes from. */
export const CriterionSource = z.enum(["§14", "§3.4", "H01"]);
/** A criterion's roadmap section. */
export type CriterionSource = z.infer<typeof CriterionSource>;

/** A Kanbanger issue that blocks a check. */
export const IssueId = z.string().regex(/^SCHO-[1-9][0-9]*$/, "expected a SchoolOS issue ID");

const CheckId = z.string().regex(/^[a-z][a-z0-9-]*$/, "expected a kebab-case check ID");

/**
 * One check of a criterion. A `test` is an executable test in this package. Where it calls a
 * domain package rather than the district app over HTTP, `direct` says why. A `todo` cannot be
 * exercised yet, and names the issues that block it.
 */
export const Check = z.discriminatedUnion("status", [
  z.strictObject({
    id: CheckId,
    status: z.literal("test"),
    name: z.string().min(1),
    direct: z.string().min(1).optional(),
  }),
  z.strictObject({
    id: CheckId,
    status: z.literal("todo"),
    name: z.string().min(1),
    blockedBy: z.array(IssueId).min(1),
    reason: z.string().min(1),
  }),
]);
/** A check. */
export type Check = z.infer<typeof Check>;

/** One gate criterion: a roadmap row and the checks that exercise it. */
export const Criterion = z.strictObject({
  id: z.string().regex(/^(s14|x34|h01)\.[a-z0-9-]+$/, "expected a criterion ID"),
  source: CriterionSource,
  /** The earliest gate that requires it. */
  gate: Gate,
  /** The row's text in the roadmap. */
  title: z.string().min(1),
  /** The roadmap's expected result. */
  expected: z.string().min(1),
  /** The test file that registers its checks. */
  file: z.string().regex(/^[a-z0-9-]+\.test\.ts$/),
  checks: z.array(Check).min(1),
});
/** A criterion. */
export type Criterion = z.infer<typeof Criterion>;

/** A criterion's status from the registry alone: met only when every check is an executable test. */
export type DeclaredStatus = "MET" | "NOT MET";

const UI = {
  student: "SCHO-22",
  teacher: "SCHO-23",
  admin: "SCHO-24",
} as const;
const UI_REASON = "The Student, Teacher and Admin UI packages are still in review; there is no UI to audit yet.";
const ROUTES_PENDING = "SCHO-107";
const DURABLE_STORES = "SCHO-108";
const CAPABILITY_ENFORCEMENT = "SCHO-120";

/** Every criterion of the pilot gate. */
export const CRITERIA: readonly Criterion[] = z.array(Criterion).parse([
  // Roadmap §14: the security and production acceptance matrix, one criterion per row.
  {
    id: "s14.cross-district",
    source: "§14",
    gate: "G0",
    title: "District B request to district A resource",
    expected: "Rejected at deployment boundary and policy layer",
    file: "security-matrix.test.ts",
    checks: [
      { id: "boundary", status: "test", name: "a Northfield token is refused at Riverbend, and Riverbend's principals find no Northfield record by ID" },
      {
        id: "policy-layer",
        status: "test",
        name: "Northfield's policy engine denies a Riverbend subject on a Northfield resource before any rule runs",
        direct: "Over HTTP a foreign principal is refused at the IdP boundary and never reaches the engine, so the district app's own engine is asked directly.",
      },
    ],
  },
  {
    id: "s14.student-peer",
    source: "§14",
    gate: "G1",
    title: "Student A attempts B's artifact and private chat",
    expected: "Denied independent of query params/client UI",
    file: "security-matrix.test.ts",
    checks: [
      { id: "artifact", status: "test", name: "a classmate cannot read, list, revise, keep or submit another student's artifact, whatever IDs, query or extra fields the request carries" },
      {
        id: "chat-engine",
        status: "test",
        name: "the district's policy engine denies a classmate reading a student's personal conversation",
        direct: "The district app has no conversation routes yet, so the decision is asked of its engine directly.",
      },
      { id: "chat-http", status: "todo", name: "a classmate cannot read another student's private AI chat over the API", blockedBy: [ROUTES_PENDING], reason: "The district app has no student AI helper or conversation routes yet." },
    ],
  },
  {
    id: "s14.teacher-conversation",
    source: "§14",
    gate: "G1",
    title: "Teacher requests unrelated personal AI conversation",
    expected: "Denied; only explicit assigned-work projections visible",
    file: "security-matrix.test.ts",
    checks: [
      { id: "projections", status: "test", name: "a teacher sees submitted work and course workspace records, never a personal workspace or its contents" },
      {
        id: "engine",
        status: "test",
        name: "the district's policy engine denies a teacher reading a student's personal conversation",
        direct: "The district app has no conversation routes yet, so the decision is asked of its engine directly.",
      },
      { id: "http", status: "todo", name: "a teacher cannot open a student's personal AI conversation over the API", blockedBy: [ROUTES_PENDING], reason: "The district app has no student AI helper or conversation routes yet." },
    ],
  },
  {
    id: "s14.tool-identity",
    source: "§14",
    gate: "G1",
    title: "MCP tool claims other student identity or untrusted `readOnlyHint`",
    expected: "Trusted principal/action policy prevails; denied/approval required",
    file: "security-matrix.test.ts",
    checks: [
      { id: "http-claims", status: "test", name: "an API request naming another principal or role is refused, and the caller is always the token's verified principal" },
      {
        id: "tool-runner",
        status: "test",
        name: "a school tool call naming another student is denied, and one with an untrusted readOnlyHint is authorized as its real action",
        direct: "The district app does not expose school tools; the tool runner is driven over the district app's own policy engine.",
      },
      { id: "mcp-surface", status: "todo", name: "the same holds through the agent-facing MCP surface", blockedBy: ["SCHO-57"], reason: "The gatekeeper-schoolos Worker that exposes school tools to agents is not built yet." },
    ],
  },
  {
    id: "s14.roster-removal",
    source: "§14",
    gate: "G2",
    title: "OneRoster removes enrolled student temporarily",
    expected: "Workspace retained; access policy updated; no automatic deletion",
    file: "security-matrix.test.ts",
    checks: [
      { id: "drop-and-return", status: "test", name: "a roster import that drops a student keeps their workspace and work, revokes their class access on the next request, and a later import restores it" },
    ],
  },
  {
    id: "s14.thin-cc-lti",
    source: "§14",
    gate: "G4",
    title: "Imported Thin CC references unregistered LTI tool",
    expected: "Resource can remain referenced but cannot be launched as authorized tool",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "never-launchable",
        status: "test",
        name: "a Thin CC LTI link is kept as a never-launchable tool reference while its web links reach the class review queue",
        direct: "The district app has no cartridge import route, so the importer is driven directly against the district app's Content Studio storage; the review queue is read over HTTP.",
      },
    ],
  },
  {
    id: "s14.prompt-injection",
    source: "§14",
    gate: "G1",
    title: "External page embeds prompt injection",
    expected: "Treated as data; no tool/system instruction escalation",
    file: "security-matrix.test.ts",
    checks: [
      { id: "data-only", status: "test", name: "an imported page with instruction-like text is flagged for review, never auto-released, and changes no policy, configuration or rights" },
    ],
  },
  {
    id: "s14.answer-key",
    source: "§14",
    gate: "G3",
    title: "Blueprint Git baseline contains answer key in old commit",
    expected: "Publication blocked or sanitized before fork",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "blocked-or-sanitized",
        status: "test",
        name: "forking a baseline whose history holds an answer key is blocked, and recreating it yields a parentless commit without the key",
        direct: "The district app saves projects but has no baseline or fork route, so its project service is built directly over the app's stores and engine.",
      },
    ],
  },
  {
    id: "s14.ai-budget",
    source: "§14",
    gate: "G1",
    title: "Stale course AI budget, underfunded student or retry duplication",
    expected: "New inference denied or billed idempotently",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "denied-or-idempotent",
        status: "test",
        name: "a closed term's course budget and an exhausted student cap deny new inference, and a retried request is billed once",
        direct: "Model requests reach the governor through the kernel AI Gateway seam (SCHO-72), not a district route, so `app.aiGovernor` is called as that seam would; usage is read over HTTP.",
      },
    ],
  },
  {
    id: "s14.ai-grader",
    source: "§14",
    gate: "G1",
    title: "AI grader suggests a score, teacher has not reviewed",
    expected: "Cannot write consequential official grade by default",
    file: "security-matrix.test.ts",
    checks: [
      { id: "suggestions", status: "test", name: "evaluator suggestions stay suggestions, a co-teacher's grade waits for the teacher, and the student sees no grade until one is official" },
      {
        id: "agent-channel",
        status: "test",
        name: "a grade written on an agent's behalf is held for teacher approval",
        direct: "No district route acts on an agent's behalf, so the assessment service is built over the app's stores and engine with an agent-channel caller.",
      },
      { id: "ai-feedback", status: "todo", name: "an AI feedback run's suggested score cannot become official over the API", blockedBy: [ROUTES_PENDING], reason: "The district app does not wire the E03 AI feedback service yet." },
    ],
  },
  {
    id: "s14.source-changed",
    source: "§14",
    gate: "G1",
    title: "Source content deleted/updated",
    expected: "Immutable prior approved revision remains or unavailability is clearly reported",
    file: "security-matrix.test.ts",
    checks: [
      { id: "prior-release-kept", status: "test", name: "after its source changes or disappears, the approved release and the activity built on it are unchanged, and a failed re-import says the source is unavailable" },
    ],
  },
  {
    id: "s14.term-end",
    source: "§14",
    gate: "G1",
    title: "Semester end / graduation",
    expected: "Classroom integration grants revoked; eligible work retained or export offered per retention policy",
    file: "security-matrix.test.ts",
    checks: [
      { id: "semester-end", status: "test", name: "closing a term revokes class grants and course AI funding, and keeps the students' work readable and keepable" },
      { id: "graduation", status: "todo", name: "a graduating student's grants end while their eligible work is kept", blockedBy: ["SCHO-51"], reason: "Principals have no lifecycle status, so graduation cannot be represented yet." },
      { id: "export-offered", status: "todo", name: "the student is offered an export of eligible work", blockedBy: ["SCHO-90"], reason: "The district app has no export route, and the exporter is not wired to submissions and feedback." },
    ],
  },
  {
    id: "s14.root-unavailable",
    source: "§14",
    gate: "G2",
    title: "Root `schoolos.dev` unavailable",
    expected: "Existing district login, work, grading and local budgets continue",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "district-continues",
        status: "test",
        name: "with the root unreachable, the entitlement cache holds and sign-in, work, grading and AI budgets continue",
        direct: "The root and the district's entitlement cache are fleet components with no district route; they are driven directly while the district works over HTTP.",
      },
    ],
  },
  {
    id: "s14.installer-revoked",
    source: "§14",
    gate: "G2",
    title: "Installer OAuth revoked",
    expected: "No new root deployment action; district app and data remain under owner control",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "no-new-action",
        status: "test",
        name: "a revoked installer credential halts the upgrade with no further change to the account, and the district app keeps serving its data",
        direct: "The installer acts on the district's Cloudflare account, not through the district app, so it runs against the fake account directly.",
      },
    ],
  },
  {
    id: "s14.registry-compromised",
    source: "§14",
    gate: "G3",
    title: "Public registry catalog compromised",
    expected: "Untrusted/unapproved signatures are rejected; pinned district data unaffected",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "rejected",
        status: "test",
        name: "a release signed by an unpinned key and a tampered framework release are rejected, and the district's pinned release and approved catalog are unchanged",
        direct: "Release offers and catalog installs have no district route yet (SCHO-107 adds the catalog routes), so the release manager and the app's catalog mirror are called directly.",
      },
    ],
  },
  {
    id: "s14.cross-district-import",
    source: "§14",
    gate: "G4",
    title: "Import from another district",
    expected: "Credentials, private peer content and restricted teacher notes not imported",
    file: "security-matrix.test.ts",
    checks: [
      {
        id: "export-side",
        status: "test",
        name: "a student's archive from the district app's own records carries no peer work, teacher-only material or credentials",
        direct: "The district app has no export route, so the P01 exporter is built over the app's stores and engine.",
      },
      { id: "transfer", status: "todo", name: "a transfer between the two district apps imports only the authorized work", blockedBy: ["SCHO-90"], reason: "Neither district app has export or transfer routes, and the exporter is not wired to submissions and feedback." },
    ],
  },
  {
    id: "s14.accessibility",
    source: "§14",
    gate: "G1",
    title: "Accessibility audit",
    expected: "Keyboard/screen reader critical pathways complete and usable",
    file: "accessibility.test.ts",
    checks: [
      { id: "audit", status: "todo", name: "an audit of the student, teacher and admin critical paths passes", blockedBy: [UI.student, UI.teacher, UI.admin], reason: UI_REASON },
    ],
  },

  // Roadmap §3.4: the pilot exit criteria.
  {
    id: "x34.districts",
    source: "§3.4",
    gate: "G0",
    title: "Two synthetic districts, at least two schools per district, three subject scenarios, multiple student principals",
    expected: "Both districts run isolated, each with two schools and writing, science and history work by several students",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "two-districts", status: "test", name: "both harness districts serve the full app in isolation, each with two schools, three subjects of installed activities and submissions from several students" },
    ],
  },
  {
    id: "x34.unauthorized-reads",
    source: "§3.4",
    gate: "G1",
    title: "Unauthorized student A cannot read B's work or teacher-only materials; a teacher cannot read a student's personal workspace",
    expected: "Every such read is refused",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "peer-work", status: "test", name: "student A cannot read student B's work or feedback" },
      { id: "teacher-only", status: "test", name: "a student sees an activity without its teacher-only material, and cannot reach teacher routes" },
      { id: "personal-workspace", status: "test", name: "a teacher cannot list or read a student's personal workspace" },
    ],
  },
  {
    id: "x34.content-sources",
    source: "§3.4",
    gate: "G1",
    title: "One content source imported via a generic URL, one via Thin CC, and one native Blueprint; all normalize into the same resource model",
    expected: "Each source becomes a reviewed release of the same resource descriptor",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "url", status: "test", name: "a generic URL becomes an approved resource release over the API" },
      {
        id: "thin-cc",
        status: "test",
        name: "a Thin CC web link becomes an approved release of the same resource descriptor",
        direct: "The district app has no cartridge import route, so the importer is driven directly against the app's Content Studio storage; review and approval are over HTTP.",
      },
      { id: "blueprint", status: "todo", name: "a native Blueprint becomes an approved release of the same resource descriptor", blockedBy: ["SCHO-121"], reason: "There is no ingest path from a native Gadgets Blueprint into the registry resource model." },
    ],
  },
  {
    id: "x34.submission-ci",
    source: "§3.4",
    gate: "G1",
    title: "One assignment produces a persistent submission snapshot and deterministic CI report; no unreviewed official grade writeback",
    expected: "Pinned snapshot, reproducible report, no official grade without a teacher",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "snapshot-and-report", status: "test", name: "a submission pins its revision digests through later edits, its CI report is reproducible, and no grade is official until the teacher records it" },
    ],
  },
  {
    id: "x34.capability-subset",
    source: "§3.4",
    gate: "G1",
    title: "Admin can enable/disable a capability for a subset of classes, predict impacted users, and roll back configuration",
    expected: "Predicted impact per class, an auditable revision, and a working rollback",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "predict", status: "test", name: "planning a capability for two classes predicts each class's students and staff without changing anything" },
      { id: "rollback", status: "test", name: "narrowing to a subset and then rolling back records each step as a revision and restores the earlier desired state" },
      { id: "enforced", status: "todo", name: "a class outside the rollout is refused the capability on its next request", blockedBy: [CAPABILITY_ENFORCEMENT], reason: "Module state and rollout reach only plan/apply; no district decision reads them yet." },
    ],
  },
  {
    id: "x34.root-outage",
    source: "§3.4",
    gate: "G1",
    title: "Artificial root outage does not interrupt existing district student/teacher activity",
    expected: "Students and teachers keep working while the root is down",
    file: "exit-criteria.test.ts",
    checks: [
      {
        id: "outage",
        status: "test",
        name: "while every root call fails, students save and submit and teachers review and grade, and the entitlement leaves the classroom unaffected",
        direct: "The root client and entitlement cache are fleet components with no district route; they are driven directly.",
      },
    ],
  },
  {
    id: "x34.end-of-term",
    source: "§3.4",
    gate: "G1",
    title: "End-of-term transition retains eligible artifacts without retaining expired course grants",
    expected: "Artifacts kept, course grants gone",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "retain", status: "test", name: "after the term closes, its artifacts and submissions remain and can be kept, while its course grants and new class work are refused" },
    ],
  },
  {
    id: "x34.metering",
    source: "§3.4",
    gate: "G1",
    title: "Full district-local metering reports accurate per-principal and per-funding-pool AI use; no root content transmission",
    expected: "Exact per-principal and per-pool totals; nothing personal reaches the root",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "accurate", status: "test", name: "the usage report's per-principal, per-class and per-pool totals equal what was settled" },
      {
        id: "no-root-content",
        status: "test",
        name: "the district's heartbeat to the root carries no names, IDs or content",
        direct: "The heartbeat is built by the fleet agent, which has no district route.",
      },
    ],
  },
  {
    id: "x34.import-errors",
    source: "§3.4",
    gate: "G1",
    title: "IdP/roster import errors do not silently remap principals or delete workspaces",
    expected: "Errors are refused or quarantined; principals and workspaces unchanged",
    file: "exit-criteria.test.ts",
    checks: [
      { id: "roster", status: "test", name: "a roster import with errors or a conflicting identity applies nothing, and no workspace is deleted" },
      { id: "idp", status: "test", name: "an expired, foreign-issuer or unknown-subject token resolves to no principal, and extra claims change nothing" },
    ],
  },
  {
    id: "x34.accessible-flows",
    source: "§3.4",
    gate: "G1",
    title: "Accessible keyboard and screen-reader flows for student, teacher and administration",
    expected: "Each surface's critical flow completes by keyboard and screen reader",
    file: "accessibility.test.ts",
    checks: [
      { id: "flows", status: "todo", name: "the student, teacher and admin flows complete by keyboard and screen reader", blockedBy: [UI.student, UI.teacher, UI.admin], reason: UI_REASON },
    ],
  },

  // H01: what the roadmap's H01 row adds.
  {
    id: "h01.revocation",
    source: "H01",
    gate: "G1",
    title: "Policy revocation mid-session",
    expected: "Revoking a grant, role or policy takes effect on the next request, with no cached authority",
    file: "revocation.test.ts",
    checks: [
      { id: "enrollment", status: "test", name: "a student dropped by a roster import is refused their class and its AI funding on the next request, with the same token" },
      { id: "teacher-role", status: "test", name: "a teacher removed from a class loses its roster, submissions and grading on the next request" },
      { id: "policy-floor", status: "test", name: "an applied configuration that disables AI spending denies the next AI request" },
      { id: "capability", status: "todo", name: "a capability disabled mid-session is refused on the next request", blockedBy: [CAPABILITY_ENFORCEMENT], reason: "Module state and rollout reach only plan/apply; no district decision reads them yet." },
    ],
  },
  {
    id: "h01.load",
    source: "H01",
    gate: "G1",
    title: "Concurrent students (smoke-level load)",
    expected: "No lost writes, idempotent submits and exact ledger totals under concurrency",
    file: "load.test.ts",
    checks: [
      { id: "saves", status: "test", name: "concurrent saves by many students lose no write" },
      { id: "submits", status: "test", name: "concurrent repeated submits produce one submission per student" },
      { id: "ledger", status: "test", name: "concurrent AI requests, retries included, leave the ledger totals exact" },
    ],
  },
  {
    id: "h01.restore",
    source: "H01",
    gate: "G3",
    title: "Restore rehearsal",
    expected: "A restored district is equivalent: directory, artifacts, submissions, ledger and configuration",
    file: "restore.test.ts",
    checks: [
      { id: "in-memory", status: "test", name: "a district snapshotted, destroyed and restored into a new app serves equivalent directory, artifacts, submissions, ledger and configuration" },
      { id: "durable", status: "todo", name: "the same rehearsal against D1 and R2 backups", blockedBy: [DURABLE_STORES], reason: "The district app's stores are in-memory only; durable stores and the Worker entry are not built." },
    ],
  },
  {
    id: "h01.accessibility",
    source: "H01",
    gate: "G1",
    title: "Accessibility of the pilot UIs",
    expected: "WCAG 2.2 AA critical paths for each UI",
    file: "accessibility.test.ts",
    checks: [
      { id: "student", status: "todo", name: "Student Learning Home critical paths meet WCAG 2.2 AA", blockedBy: [UI.student], reason: UI_REASON },
      { id: "teacher", status: "todo", name: "Teacher Studio critical paths meet WCAG 2.2 AA", blockedBy: [UI.teacher], reason: UI_REASON },
      { id: "admin", status: "todo", name: "District admin console critical paths meet WCAG 2.2 AA", blockedBy: [UI.admin], reason: UI_REASON },
    ],
  },
]);

/** The criterion with this ID. Throws if there is none. */
export function criterionById(id: string): Criterion {
  const criterion = CRITERIA.find((c) => c.id === id);
  if (criterion === undefined) throw new Error(`no gate criterion ${id}`);
  return criterion;
}

/** The describe-block title a criterion's tests are registered under: its section and row text. */
export function criterionTitle(criterion: Criterion): string {
  return `${criterion.source}: ${criterion.title}`;
}

/** The name a check's test is registered under. A todo's name carries its blocking issues. */
export function checkTestName(check: Check): string {
  return check.status === "todo" ? `${check.name} [todo: blocked by ${check.blockedBy.join(", ")}]` : check.name;
}

/** The full name Vitest reports a check's test under. */
export function checkFullName(criterion: Criterion, check: Check): string {
  return `${criterionTitle(criterion)} > ${checkTestName(check)}`;
}

/** Whether a criterion can be met as registered: only if none of its checks is a todo. */
export function declaredStatus(criterion: Criterion): DeclaredStatus {
  return criterion.checks.every((check) => check.status === "test") ? "MET" : "NOT MET";
}

/** The issues blocking a criterion, in order of first mention. */
export function blockersOf(criterion: Criterion): string[] {
  return [...new Set(criterion.checks.flatMap((check) => (check.status === "todo" ? check.blockedBy : [])))];
}

/** The criteria a gate requires: its own and every earlier gate's. */
export function criteriaForGate(gate: Gate): Criterion[] {
  const rank = Gate.options.indexOf(gate);
  return CRITERIA.filter((criterion) => Gate.options.indexOf(criterion.gate) <= rank);
}
