// A scripted district API client for the console's journey tests: an in-memory district with four
// classes, a configuration history and a roster import, answering the admin routes the way the
// district app does in the cases the tests exercise. Plans are computed from the documents the
// console sends, so a test sees the consequences of what it clicked; `configDocument.test.ts`
// checks the same documents against the real district app. Not a test file: vitest collects only
// `*.test.*`.
import { DistrictApiError, type CallArgs, type DistrictApiClient, type RouteName, type RouteResponse } from "@educateos/api-client";
import { POLICY_ORDERINGS, type ConfigurationRevision, type PolicySettings } from "@educateos/contracts";
import type { ConfigurationPlan, DiffEntry } from "../app/useDistrictConfig.ts";
import type { DesiredStateView } from "../configDocument.ts";

/** A synthetic class. */
export interface FakeClass {
  offeringId: string;
  schoolId: string;
  students: number;
  staff: number;
}

const COURSE_TITLES: Readonly<Record<string, string>> = { bio: "Biology", eng: "English 9", math: "Math 7", art: "Art 6" };
const SCHOOL_NAMES: Readonly<Record<string, string>> = { "sch_fk-high": "Fake High School", "sch_fk-middle": "Fake Middle School" };
const TERM = { id: "trm_fk-2026-fall", districtId: "dst_fake", name: "Fall 2026", startsOn: "2026-08-24", endsOn: "2026-12-18", state: "active" };

/** A class's course and section, as the district names them: `off_fk-bio-a` is Biology, Section A. */
function classRecords(c: FakeClass) {
  const [, code, section] = /^off_fk-([a-z]+)\d*-([a-z])$/.exec(c.offeringId)!;
  return {
    offering: { id: c.offeringId, districtId: "dst_fake", schoolId: c.schoolId, termId: TERM.id, courseId: `crs_fk-${code}`, sectionName: `Section ${section!.toUpperCase()}` },
    course: { id: `crs_fk-${code}`, districtId: "dst_fake", title: COURSE_TITLES[code!]!, subject: "other", gradeBand: "9" },
  };
}

/** A class's name in the console: its course and section, such as "Biology · Section A". */
export const classTitle = (c: FakeClass): string => {
  const { course, offering } = classRecords(c);
  return `${course.title} · ${offering.sectionName}`;
};
const TEACHERS = ["Sam Rivera", "Wen Chen"];

/** The synthetic students' names. They exist only so tests can prove the aggregates never show them. */
export const STUDENT_NAMES = ["Amara Okafor", "Jonah Pike", "Lena Ortiz"] as const;

/** The district's four active classes. */
export const CLASSES: readonly FakeClass[] = [
  { offeringId: "off_fk-bio-a", schoolId: "sch_fk-high", students: 24, staff: 1 },
  { offeringId: "off_fk-eng9-b", schoolId: "sch_fk-high", students: 27, staff: 2 },
  { offeringId: "off_fk-math7-c", schoolId: "sch_fk-middle", students: 22, staff: 1 },
  { offeringId: "off_fk-art6-d", schoolId: "sch_fk-middle", students: 18, staff: 1 },
];

const POLICIES: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 200,
};

function initialDesired(): DesiredStateView {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: "dst_fake" as DesiredStateView["district"],
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    modules: {
      ["core-learning" as never]: { state: "disabled", version: "1.0.0", config: {} },
      ["learning-artifacts" as never]: { state: "disabled", version: "1.0.0", config: {}, requiredBy: ["core-learning" as never] },
    },
    rollout: { target: "all-active-offerings", offerings: [], requiresAdminActivation: true },
    policies: POLICIES,
    overrides: [],
  };
}

/** JSON with object keys sorted, so equal values compare equal whatever order they were built in. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b))) : v);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function diff(before: unknown, after: unknown, path = ""): DiffEntry[] {
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted().flatMap((key) => {
      const child = `${path}/${key}`;
      if (!(key in after)) return [{ path: child, change: "removed" as const, before: before[key] }];
      if (!(key in before)) return [{ path: child, change: "added" as const, after: after[key] }];
      return diff(before[key], after[key], child);
    });
  }
  return canonical(before) === canonical(after) ? [] : [{ path, change: "changed", before, after }];
}

/** The desired state a document compiles to, in the fake's simplified compiler. */
function compile(document: Record<string, unknown>, previous: DesiredStateView): DesiredStateView | string {
  const rollout = document.rollout as { target: DesiredStateView["rollout"]["target"]; offerings?: string[]; requiresAdminActivation: boolean };
  if (rollout.target === "selected-course-offerings" && (rollout.offerings ?? []).length === 0) return "name at least one offering";
  const modules = Object.fromEntries(Object.entries(document.modules as Record<string, { state: "enabled" | "disabled" | "advisory"; config?: Record<string, unknown> } | string>)
    .map(([id, entry]) => {
      const state = typeof entry === "string" ? entry : entry.state;
      const config = typeof entry === "string" ? {} : entry.config ?? {};
      return [id, { state, version: "1.0.0", config }];
    })) as DesiredStateView["modules"];
  if (modules["core-learning" as never] !== undefined && modules["learning-artifacts" as never] === undefined) {
    modules["learning-artifacts" as never] = { state: modules["core-learning" as never]!.state, version: "1.0.0", config: {}, requiredBy: ["core-learning" as never] };
  }
  const policies = document.policies as { ai?: { spending?: string; promptsInGatewayLogs?: boolean; monthlyCapCentsPerPrincipal?: number } } & Record<string, string>;
  return {
    ...previous,
    modules,
    rollout: { target: rollout.target, offerings: [...(rollout.offerings ?? [])].toSorted() as never, requiresAdminActivation: rollout.requiresAdminActivation },
    policies: {
      aiSpending: (policies.ai?.spending ?? previous.policies.aiSpending) as PolicySettings["aiSpending"],
      promptsInGatewayLogs: policies.ai?.promptsInGatewayLogs === undefined ? previous.policies.promptsInGatewayLogs : policies.ai.promptsInGatewayLogs ? "permitted" : "prohibited",
      aiMonthlyCapCentsPerPrincipal: policies.ai?.monthlyCapCentsPerPrincipal ?? previous.policies.aiMonthlyCapCentsPerPrincipal,
      studentPersonalConversations: (policies.studentPersonalConversations ?? previous.policies.studentPersonalConversations) as PolicySettings["studentPersonalConversations"],
      teacherObservation: (policies.teacherObservation ?? previous.policies.teacherObservation) as PolicySettings["teacherObservation"],
      automatedSelProfiling: (policies.automatedSelProfiling ?? previous.policies.automatedSelProfiling) as PolicySettings["automatedSelProfiling"],
    },
  };
}

function exposure(desired: DesiredStateView, id: string): string[] {
  if (desired.modules[id as never]?.state === "disabled" || desired.modules[id as never] === undefined) return [];
  return desired.rollout.target === "all-active-offerings" ? CLASSES.map((c) => c.offeringId) : desired.rollout.offerings;
}

const activation = (state: string | undefined, exposedTo: string[]) => ({
  state: exposedTo.length > 0 ? "exposed" : state === "disabled" ? "installed" : "enabled",
  mode: state ?? "disabled",
  version: "1.0.0",
  exposedTo,
});

function plan(current: DesiredStateView, next: DesiredStateView): ConfigurationPlan {
  const ids = [...new Set([...Object.keys(current.modules), ...Object.keys(next.modules)])].toSorted();
  const packs = ids.flatMap((id) => {
    const before = exposure(current, id);
    const after = exposure(next, id);
    const was = current.modules[id as never]?.state;
    const will = next.modules[id as never]?.state;
    const changes = [
      ...(was === "disabled" && will !== "disabled" ? ["enabled" as const] : []),
      ...(was !== "disabled" && will === "disabled" ? ["disabled" as const] : []),
      ...(JSON.stringify(before) === JSON.stringify(after) ? [] : ["exposure-changed" as const]),
    ];
    if (changes.length === 0) return [];
    return [{
      capabilityId: id,
      before: activation(was, before),
      after: activation(will, after),
      changes,
      exposedTo: after.filter((o) => !before.includes(o)),
      withdrawnFrom: before.filter((o) => !after.includes(o)),
    }];
  }) as ConfigurationPlan["packs"];
  const offerings = CLASSES.flatMap((c) => {
    const packsExposed = packs.filter((p) => p.exposedTo.includes(c.offeringId as never)).map((p) => p.capabilityId);
    const packsWithdrawn = packs.filter((p) => p.withdrawnFrom.includes(c.offeringId as never)).map((p) => p.capabilityId);
    const policyChanged = canonical(current.policies) !== canonical(next.policies);
    if (packsExposed.length === 0 && packsWithdrawn.length === 0 && !policyChanged) return [];
    return [{
      offeringId: c.offeringId,
      schoolId: c.schoolId,
      students: c.students,
      staff: c.staff,
      packsExposed,
      packsWithdrawn,
      policyChanged,
      policy: {
        effective: next.policies,
        sources: Object.fromEntries(Object.keys(next.policies).map((k) => [k, k === "aiMonthlyCapCentsPerPrincipal" ? "profile" : "district"])),
      },
    }];
  }) as ConfigurationPlan["offerings"];
  const approvals = (Object.keys(POLICY_ORDERINGS) as (keyof typeof POLICY_ORDERINGS)[])
    .filter((key) => (POLICY_ORDERINGS[key] as readonly string[]).indexOf(next.policies[key] ?? "") < (POLICY_ORDERINGS[key] as readonly string[]).indexOf(current.policies[key] ?? ""))
    .map((key) => ({ role: "district-admin" as const, reason: "policy-loosened" as const, path: `/policies/${key}`, detail: `${key} loosens` }));
  if (next.policies.aiMonthlyCapCentsPerPrincipal > current.policies.aiMonthlyCapCentsPerPrincipal) {
    approvals.push({ role: "district-admin", reason: "policy-loosened", path: "/policies/aiMonthlyCapCentsPerPrincipal", detail: "the monthly cap rises" });
  }
  return {
    diff: diff(current, next),
    installOrder: ids as never,
    packs,
    dependencyEffects: packs
      .filter((p) => next.modules[p.capabilityId]?.requiredBy !== undefined && p.changes.includes("enabled"))
      .map((p) => ({ capabilityId: p.capabilityId, pulledInBy: next.modules[p.capabilityId]!.requiredBy!, state: p.after!.state })),
    offerings,
    policyViolations: [],
    approvals,
    migrations: [],
    cost: { packs: [], principals: 0, aiPrincipals: 0, aiMonthlyCeilingCents: 0, previousAiMonthlyCeilingCents: 0 },
    problems: [],
  };
}

const changes = (prefix: string) => ({ added: [`${prefix}_new`], updated: [`${prefix}_upd`], deactivated: [], retained: [] });

/** A roster preview with two changes of each kind and one quarantined user. */
export function rosterPreview(): RouteResponse<"admin.previewRoster"> {
  return {
    canApply: true,
    issues: [{ severity: "warning", file: "demographics.csv", message: "demographics.csv is not read; it was skipped." }],
    integrity: [],
    quarantined: [{
      sourcedId: "u-301",
      row: 7,
      principalId: "prn_fk-student-301",
      reason: "subject-changed",
      message: "This user's sign-in changed from s301@learners.fake.example to s301b@learners.fake.example.",
      heldEnrollments: 2,
    }],
    linked: [],
    changes: {
      schools: changes("sch"),
      terms: changes("trm"),
      courses: changes("crs"),
      offerings: changes("off"),
      principals: { added: ["prn_a", "prn_b"], updated: [], deactivated: ["prn_c"], retained: [] },
      enrollments: { added: ["enr_a"], updated: [], deactivated: ["enr_b"], retained: [] },
      roleAssignments: { added: [], removed: [] },
    },
  } as unknown as RouteResponse<"admin.previewRoster">;
}

type SyncRun = RouteResponse<"admin.rosterSyncStatus">["runs"][number];
type SyncCounts = SyncRun["counts"];

const NO_CHANGE = { added: 0, updated: 0, deactivated: 0 };

/** Sync counts: no change except where `changed` says. */
const syncCounts = (changed: Partial<SyncCounts> = {}): SyncCounts => ({
  schools: NO_CHANGE, terms: NO_CHANGE, courses: NO_CHANGE, offerings: NO_CHANGE, principals: NO_CHANGE, enrollments: NO_CHANGE,
  roleAssignments: { added: 0, removed: 0 },
  ...changed,
});

/** The fake roster's sync history: the first complete sync, then a delta that changed one student. */
function initialSyncRuns(): SyncRun[] {
  return [
    {
      id: "sched-1", mode: "complete", startedAt: "2026-10-28T06:00:00.000Z", finishedAt: "2026-10-28T06:00:42.000Z", outcome: "succeeded", quarantined: 0,
      counts: syncCounts({
        schools: { added: 2, updated: 0, deactivated: 0 }, terms: { added: 1, updated: 0, deactivated: 0 }, courses: { added: 4, updated: 0, deactivated: 0 },
        offerings: { added: 4, updated: 0, deactivated: 0 }, principals: { added: 96, updated: 0, deactivated: 0 }, enrollments: { added: 96, updated: 0, deactivated: 0 },
        roleAssignments: { added: 5, removed: 0 },
      }),
    },
    {
      id: "sched-2", mode: "delta", startedAt: "2026-10-28T06:15:00.000Z", finishedAt: "2026-10-28T06:15:03.000Z", outcome: "succeeded", quarantined: 0,
      counts: syncCounts({ principals: { added: 0, updated: 1, deactivated: 0 } }),
    },
  ];
}

/** What a sync of the fake roster reads: one student moved class, one left, one is held for review. */
function syncPreview(issues: { severity: "error" | "warning"; file?: string; row?: number; column?: string; sourcedId?: string; message: string }[]) {
  return { ...rosterPreview(), canApply: !issues.some((issue) => issue.severity === "error"), issues };
}

const totals = (requests: number, cents: number) => ({
  requests, inputTokens: requests * 200, outputTokens: requests * 100, cacheReadTokens: 0, cacheWriteTokens: 0, attempts: requests, unknownCostRequests: 0,
  usageUsdNano: String(cents * 10_000_000), adjustmentUsdNano: "0", totalUsdNano: String(cents * 10_000_000),
});

/** A synthetic funding pool: its configuration and what it has charged and held this month, in cents. */
interface FakePool {
  poolId: string;
  name: string;
  purpose: "course" | "personal" | "safety";
  allocationCents: number;
  chargedUsdNano: bigint;
  heldUsdNano: bigint;
}

const NANO_PER_CENT = 10_000_000n;

/**
 * The district's pools: $10 for classes (78% used, projected well over), $5 for personal spaces,
 * and a $3 safety reserve that has paid for three moderation checks of $0.000038 each.
 */
function initialPools(): FakePool[] {
  return [
    { poolId: "fpl_fk-courses", name: "Course AI", purpose: "course", allocationCents: 1000, chargedUsdNano: 760n * NANO_PER_CENT, heldUsdNano: 20n * NANO_PER_CENT },
    { poolId: "fpl_fk-personal", name: "Personal AI", purpose: "personal", allocationCents: 500, chargedUsdNano: 50n * NANO_PER_CENT, heldUsdNano: 0n },
    { poolId: "fpl_fk-safety", name: "Safety reserve", purpose: "safety", allocationCents: 300, chargedUsdNano: 114_000n, heldUsdNano: 0n },
  ];
}

/** The district's cap on its class and personal pools together: $20. */
export const DISTRICT_CAP_CENTS = 2000;
/** The safety reserve's recommended minimum: $0.10 for each of the 5 teachers and 91 students. */
const RECOMMENDED_SAFETY_USD_NANO = 9_600_000_000n;

function poolStatus(pool: FakePool) {
  const allocation = BigInt(pool.allocationCents) * NANO_PER_CENT;
  const used = pool.chargedUsdNano + pool.heldUsdNano;
  const points = allocation === 0n ? undefined : Number(used * 10_000n / allocation);
  const threshold = points === undefined ? (used > 0n ? "exhausted" : "none")
    : points >= 10_000 ? "exhausted" : points >= 9_500 ? "critical" : points >= 8_500 ? "warning" : points >= 7_000 ? "info" : "none";
  return {
    poolId: pool.poolId,
    name: pool.name,
    purpose: pool.purpose,
    scope: { level: "district", districtId: "dst_fake" },
    monthlyAllocationUsdNano: allocation.toString(),
    chargedUsdNano: pool.chargedUsdNano.toString(),
    heldUsdNano: pool.heldUsdNano.toString(),
    remainingUsdNano: (allocation - used).toString(),
    utilizationPercent: points === undefined ? null : points / 100,
    threshold,
  };
}

/** Options for {@link fakeDistrict}. */
export interface FakeDistrictOptions {
  /** Whether the district has Cloudflare account facts, and so a net estimate. Defaults to false. */
  netEstimate?: boolean;
  /** Who owns the directory: the roster (the default) or EducateOS, as for a co-op with no roster. */
  authority?: "oneroster" | "local";
  /**
   * Who is calling: a district administrator (the default), a person the school added who is not
   * one, whom every admin route refuses, or a sign-in the school has not added, whom every route
   * refuses with the sign-in to give an administrator.
   */
  caller?: "administrator" | "not-administrator" | "unlinked";
  /**
   * The roster sync: a Clever sync that runs (the default), one whose next run the feed rejects or
   * whose next run is held for a large removal, a OneRoster connection this deployment cannot run,
   * or a status the district cannot read.
   */
  rosterSync?: "runnable" | "feed-rejected" | "removal-held" | "not-runnable" | "unreadable";
}

/** The sign-in an `unlinked` caller signed in with. */
export const UNLINKED_SIGN_IN = { issuer: "https://fake.cloudflareaccess.com", subject: "a1b2c3-new-person" };

const ISSUER = "https://fake.cloudflareaccess.com";

/**
 * A directory the classes screen authors, enforcing what the district does where the screen
 * depends on it: writes to a type the roster owns are refused naming it, archived sections take
 * no one new, and removing someone keeps their enrollment, inactive.
 */
function fakeAuthoring(owner: "oneroster" | "local") {
  const authority = Object.fromEntries(["school", "term", "course", "offering", "enrollment", "principal"].map((kind) => [kind, owner === "local" ? "local" : "external:oneroster"]));
  // A roster district's records came from its roster: the four classes, their schools and term.
  const rostered = owner === "local" ? [] : CLASSES.map(classRecords);
  const directory = {
    authority,
    trustedIssuers: [ISSUER],
    schools: (owner === "local" ? [] : Object.entries(SCHOOL_NAMES).map(([id, name]) => ({ id, districtId: "dst_fake", name, gradeBands: ["9-12"] }))) as Record<string, unknown>[],
    terms: (owner === "local" ? [] : [{ ...TERM }]) as Record<string, unknown>[],
    courses: rostered.map((r) => r.course).filter((c, i, all) => all.findIndex((other) => other.id === c.id) === i) as Record<string, unknown>[],
    offerings: rostered.map((r) => r.offering) as Record<string, unknown>[],
    principals: [{ id: "prn_fk-admin", kind: "staff", status: "active", displayName: "Avery Admin", districtAdmin: true }] as Record<string, unknown>[],
  };
  const enrollments: Record<string, unknown>[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}_fk-${++n}`;
  const local = (kind: string) => {
    if (authority[kind] !== "local") throw new DistrictApiError(409, { code: "conflict", message: `Records of this kind are owned by ${authority[kind]}; change them there and let its sync update EducateOS.` });
  };
  const add = (kind: string, list: Record<string, unknown>[], record: Record<string, unknown>) => {
    local(kind);
    list.push(record);
    return record;
  };
  const find = (list: Record<string, unknown>[], recordId: unknown) => list.find((r) => r.id === recordId)!;
  const params = (input: Record<string, unknown>) => input.params as Record<string, string>;
  const body = (input: Record<string, unknown>) => input.body as Record<string, unknown>;
  const update = (kind: string, list: Record<string, unknown>[], recordId: string, change: Record<string, unknown>) => {
    local(kind);
    return Object.assign(find(list, recordId), change);
  };
  const archive = (kind: string, list: Record<string, unknown>[], recordId: string, archived: boolean) => {
    local(kind);
    const record = find(list, recordId);
    if (archived) record.archivedAt = "2026-10-23T12:00:00.000Z";
    else delete record.archivedAt;
    return record;
  };
  return {
    "admin.authoring": () => directory,
    "admin.createSchool": (input: Record<string, unknown>) => add("school", directory.schools, { id: id("sch"), districtId: "dst_fake", ...body(input) }),
    "admin.updateSchool": (input: Record<string, unknown>) => update("school", directory.schools, params(input).schoolId!, body(input)),
    "admin.updateTerm": (input: Record<string, unknown>) => update("term", directory.terms, params(input).termId!, body(input)),
    "admin.updateCourse": (input: Record<string, unknown>) => update("course", directory.courses, params(input).courseId!, body(input)),
    "admin.createTerm": (input: Record<string, unknown>) => add("term", directory.terms, { id: id("trm"), districtId: "dst_fake", ...body(input), state: "planned" }),
    "admin.transitionTerm": (input: Record<string, unknown>) => {
      local("term");
      return Object.assign(find(directory.terms, params(input).termId), { state: body(input).to });
    },
    "admin.createCourse": (input: Record<string, unknown>) => add("course", directory.courses, { id: id("crs"), districtId: "dst_fake", ...body(input) }),
    "admin.archiveCourse": (input: Record<string, unknown>) => archive("course", directory.courses, params(input).courseId!, body(input).archived === true),
    "admin.createOffering": (input: Record<string, unknown>) => add("offering", directory.offerings, { id: id("off"), districtId: "dst_fake", ...body(input) }),
    "admin.archiveOffering": (input: Record<string, unknown>) => archive("offering", directory.offerings, params(input).offeringId!, body(input).archived === true),
    "admin.createPrincipal": (input: Record<string, unknown>) => {
      const { identity: _, ...person } = body(input);
      return add("principal", directory.principals, { id: id("prn"), status: "active", ...person, districtAdmin: false });
    },
    // SCHO-212. Like the district: a kind is fixed once someone is in a section, only active staff
    // become administrators, and the last administrator stays one.
    "admin.updatePrincipal": (input: Record<string, unknown>) => {
      local("principal");
      const person = find(directory.principals, params(input).principalId);
      const { email, ...change } = body(input);
      if (change.kind !== undefined && change.kind !== person.kind && enrollments.some((e) => e.principalId === person.id)) {
        throw new DistrictApiError(409, { code: "conflict", message: `${String(person.displayName)} already has enrollments, which belong to their current kind.` });
      }
      if (email === null) delete person.email;
      else if (email !== undefined) person.email = email;
      return Object.assign(person, change);
    },
    "admin.setPrincipalStatus": (input: Record<string, unknown>) => {
      local("principal");
      const person = find(directory.principals, params(input).principalId);
      return { principal: Object.assign(person, { status: body(input).status, ...(body(input).status === "active" ? {} : { districtAdmin: false }) }), grantsRevoked: 0 };
    },
    "admin.grantDistrictAdmin": (input: Record<string, unknown>) => {
      const person = find(directory.principals, params(input).principalId);
      if (person.kind !== "staff") throw new DistrictApiError(409, { code: "conflict", message: "Only staff can be district administrators." });
      return Object.assign(person, { districtAdmin: true });
    },
    "admin.revokeDistrictAdmin": (input: Record<string, unknown>) => {
      const person = find(directory.principals, params(input).principalId);
      if (directory.principals.filter((p) => p.districtAdmin === true && p.id !== person.id).length === 0) {
        throw new DistrictApiError(409, { code: "conflict", message: "This is the district's last administrator; make someone else an administrator first." });
      }
      return Object.assign(person, { districtAdmin: false });
    },
    "admin.offeringRoster": (input: Record<string, unknown>) => enrollments
      .filter((e) => e.offeringId === params(input).offeringId && e.status === "active")
      .map((enrollment) => ({ enrollment, displayName: find(directory.principals, enrollment.principalId).displayName })),
    "admin.enroll": (input: Record<string, unknown>) => {
      local("enrollment");
      if (find(directory.offerings, params(input).offeringId).archivedAt !== undefined) {
        throw new DistrictApiError(409, { code: "conflict", message: "This section is archived; restore it before enrolling anyone." });
      }
      const enrollment = { id: id("enr"), districtId: "dst_fake", offeringId: params(input).offeringId, ...body(input), status: "active" };
      enrollments.push(enrollment);
      return enrollment;
    },
    "admin.unenroll": (input: Record<string, unknown>) => {
      local("enrollment");
      const enrollment = Object.assign(find(enrollments, params(input).enrollmentId), { status: "inactive" });
      return { enrollment, grantsRevoked: 1 };
    },
  };
}

/** The built-in standards the fake district lists (SCHO-220). */
const STANDARDS: { frameworkKey: string; title: string; publisher: string; subjects: string[]; gradeBands: string[]; version: string; license: { name: string; termsUrl: string }; status: "approved" | "not-approved"; decided?: { by: string; at: string } }[] = [
  {
    frameworkKey: "ccss-ela", title: "Common Core State Standards for English Language Arts", publisher: "NGA Center and CCSSO", subjects: ["english-language-arts"],
    gradeBands: ["K-2", "3-5", "6-8", "9-12"], version: "1.1.0", license: { name: "Common Core State Standards Public License", termsUrl: "https://www.thecorestandards.org/public-license/" }, status: "not-approved",
  },
  {
    frameworkKey: "c3", title: "College, Career, and Civic Life (C3) Framework", publisher: "National Council for the Social Studies", subjects: ["social-studies"],
    gradeBands: ["K-2", "3-5", "6-8", "9-12"], version: "1.1.0", license: { name: "C3 terms of use", termsUrl: "https://www.socialstudies.org/standards/c3" }, status: "not-approved",
  },
];

/** The fake district: the client the console is given, and what it was asked. */
export interface FakeDistrict {
  /** The client. */
  client: DistrictApiClient;
  /** Every route called, in order, with its input. */
  calls: { name: RouteName; input: unknown }[];
  /** The revisions applied, oldest first. */
  revisions: ConfigurationRevision[];
  /** The funding allocation revisions recorded, oldest first. */
  allocationRevisions: { id: string; allocations: Record<string, string> }[];
}

/** A fresh fake district whose first configuration has every module off. */
export function fakeDistrict(options: FakeDistrictOptions = {}): FakeDistrict {
  const calls: FakeDistrict["calls"] = [];
  const pools = initialPools();
  const allocationRevisions: FakeDistrict["allocationRevisions"] = [];
  const funding = () => {
    const statuses = pools.map(poolStatus);
    const safety = statuses.find((p) => p.purpose === "safety");
    const head = allocationRevisions.at(-1);
    return {
      report: {
        period: "2026-10",
        pools: statuses.filter((p) => p.purpose !== "safety"),
        safety: {
          ...(safety === undefined ? {} : { pool: safety }),
          population: { activeTeachers: 5, aiEnabledStudents: 91 },
          recommendedMinimumUsdNano: RECOMMENDED_SAFETY_USD_NANO.toString(),
          belowRecommended: safety === undefined || BigInt(safety.monthlyAllocationUsdNano) < RECOMMENDED_SAFETY_USD_NANO,
        },
        generativeAllocationUsdNano: (BigInt(pools.filter((p) => p.purpose !== "safety").reduce((t, p) => t + p.allocationCents, 0)) * NANO_PER_CENT).toString(),
        districtCapUsdNano: (BigInt(DISTRICT_CAP_CENTS) * NANO_PER_CENT).toString(),
      },
      ...(head === undefined ? {} : {
        revision: { id: head.id, number: allocationRevisions.length, allocations: head.allocations, actorPrincipalId: "prn_fk-admin", appliedAt: "2026-10-05T15:00:00.000Z" },
      }),
    };
  };
  let sequence = 1;
  const revision = (desired: DesiredStateView, previous?: ConfigurationRevision): ConfigurationRevision => ({
    id: `cfg_fake-${sequence++}` as ConfigurationRevision["id"],
    scope: { districtId: "dst_fake" as never },
    schemaVersion: "educateos.io/v1alpha1",
    desired,
    status: "applied",
    actorPrincipalId: "prn_fk-admin" as never,
    ...(previous === undefined ? {} : { previousRevisionId: previous.id }),
  });
  const revisions = [revision(initialDesired())];
  const headDesired = () => revisions.at(-1)!.desired as DesiredStateView;

  const standards = STANDARDS.map((entry) => structuredClone(entry));
  const standardsFor = (input: Record<string, unknown>) => {
    const entry = standards.find((s) => s.frameworkKey === (input.params as Record<string, string>).frameworkKey);
    if (entry === undefined) throw new DistrictApiError(404, { code: "not-found", message: "No such standards." });
    return entry;
  };
  const opsKeys: { keyId: string; status: string; [field: string]: unknown }[] = [];
  const opsAudit = [
    { id: "opa_1", keyId: "ed25519-earlier", operator: "ops@educateos.io", route: "health", result: "ok", at: "2026-10-28T11:00:00.000Z" },
    { id: "opa_2", keyId: "ed25519-earlier", operator: "ops@educateos.io", route: "directory.action", target: "prn_fk-student-301/suspend", result: "applied", at: "2026-10-28T11:05:00.000Z" },
  ];
  const syncRuns = options.rosterSync === "not-runnable" ? [] : initialSyncRuns();
  let approvedRemoval: string | undefined;
  const HELD_FINGERPRINT = "a".repeat(64);
  const handlers: { [N in RouteName]?: (input: Record<string, unknown>) => RouteResponse<N> } = {
    // Loosely typed, like the other handlers' `as never` answers.
    ...(fakeAuthoring(options.authority ?? "oneroster") as object),
    "me.get": () => ({ principalId: "prn_fk-admin", districtId: "dst_fake", kind: "staff", displayName: "Avery Admin", roles: [], enrollments: [] }) as never,
    "admin.health": () => ({
      districtId: "dst_fake",
      directory: { schools: 2, terms: 1, offerings: CLASSES.length, students: 91, staff: 5, activeEnrollments: 96 },
      work: { workspaces: 12, artifacts: 30, submissions: 8, installedActivities: 4 },
      content: { awaitingReview: 3, releases: 2 },
      config: { headRevisionId: revisions.at(-1)!.id, revisions: revisions.length },
      aiRequests: 41,
      authority: Object.fromEntries(["school", "term", "course", "offering", "enrollment", "principal"].map((kind) => [kind, options.authority === "local" ? "local" : "external:oneroster"])),
    }) as never,
    "admin.aiUsage": () => {
      return {
        district: totals(41, 860),
        byPrincipal: { "prn_fk-student-301": totals(30, 200), "prn_fk-student-302": totals(9, 170), "prn_fk-student-303": totals(2, 40) },
        byOffering: { "off_fk-bio-a": totals(25, 500), "off_fk-eng9-b": totals(10, 260) },
        personal: totals(6, 100),
        byPool: { "fpl_fk-courses": totals(35, 760) },
        byModel: { "cloudflare/synthetic-model": totals(41, 860) },
        unattributed: totals(0, 0),
      } as never;
    },
    "admin.aiFunding": () => funding() as never,
    "admin.aiCostSummary": () => ({
      period: "2026-10",
      requests: 44,
      grossModelCostUsdNano: "8100114000",
      reconciliationAdjustmentUsdNano: "0",
      heldUsdNano: "200000000",
      unknownCostRequests: 1,
      safetySpendUsdNano: "114000",
      net: options.netEstimate === true
        ? {
          status: "estimated",
          accountId: "acct-fake",
          grossUsageUsdNano: "13100114000",
          freeAllowanceAppliedUsdNano: "110000000",
          planFeeUsdNano: "5000000000",
          netEstimatedUsdNano: "12990114000",
          allocations: [],
          unknownCostRequests: 1,
        }
        : { status: "unavailable", reason: "No Cloudflare account is configured for this district, so the included allowances and plan fee cannot be applied. Only the gross model cost is shown." },
    }) as never,
    "admin.aiProjection": () => ({
      period: "2026-10",
      asOf: "2026-10-05T15:00:00.000Z",
      elapsedDays: 4.625,
      monthDays: 31,
      warningPercent: 80,
      pools: [
        { poolId: "fpl_fk-courses", name: "Course AI", purpose: "course", monthlyAllocationUsdNano: "10000000000", monthToDateUsdNano: "7800000000", projectedUsdNano: "52281081082", projectedUtilizationPercent: 522.81, flagged: true },
        { poolId: "fpl_fk-personal", name: "Personal AI", purpose: "personal", monthlyAllocationUsdNano: "5000000000", monthToDateUsdNano: "500000000", projectedUsdNano: "3351351352", projectedUtilizationPercent: 67.02, flagged: false },
        { poolId: "fpl_fk-safety", name: "Safety reserve", purpose: "safety", monthlyAllocationUsdNano: "3000000000", monthToDateUsdNano: "114000", projectedUsdNano: "764109", projectedUtilizationPercent: 0.02, flagged: false },
      ],
    }) as never,
    "admin.updateFundingPools": (input) => {
      const body = input.body as { allocations: { poolId: string; monthlyAllocationCents: number }[]; expectedRevisionId?: string };
      if (body.expectedRevisionId !== allocationRevisions.at(-1)?.id) {
        throw new DistrictApiError(409, { code: "conflict", message: "The funding allocations changed since you loaded them; review them again." });
      }
      const next = pools.map((pool) => body.allocations.find((a) => a.poolId === pool.poolId)?.monthlyAllocationCents ?? pool.allocationCents);
      const generative = next.filter((_, i) => pools[i]!.purpose !== "safety").reduce((t, c) => t + c, 0);
      if (generative > DISTRICT_CAP_CENTS) {
        throw new DistrictApiError(400, { code: "validation-failed", message: "The course and personal pools would total more than the district's cap." });
      }
      next.forEach((cents, i) => { pools[i]!.allocationCents = cents; });
      allocationRevisions.push({ id: `far_fake-${allocationRevisions.length + 1}`, allocations: Object.fromEntries(pools.map((p) => [p.poolId, (BigInt(p.allocationCents) * NANO_PER_CENT).toString()])) });
      const safety = pools.find((p) => p.purpose === "safety")!;
      const warnings = BigInt(safety.allocationCents) * NANO_PER_CENT < RECOMMENDED_SAFETY_USD_NANO
        ? [`The safety reserve is $${(safety.allocationCents / 100).toFixed(2)} a month, below the recommended $9.60.`]
        : [];
      return { ...funding(), changed: true, warnings } as never;
    },
    "admin.getConfig": () => ({ head: revisions.at(-1)!, revisions: revisions.length, districtPolicy: headDesired().policies }) as never,
    "admin.planConfig": (input) => {
      const next = compile((input.body as { document: Record<string, unknown> }).document, headDesired());
      if (typeof next === "string") return { ok: false, problems: [{ code: "invalid-document", path: "/rollout/offerings", message: next }] } as never;
      return { ok: true, revision: revision(next, revisions.at(-1)), plan: plan(headDesired(), next) } as never;
    },
    "admin.applyConfig": (input) => {
      const body = input.body as { document: Record<string, unknown>; expectedHeadRevisionId?: string; acknowledgeApprovals?: boolean };
      if (body.expectedHeadRevisionId !== revisions.at(-1)!.id) throw new DistrictApiError(409, { code: "conflict", message: "The configuration changed since this plan was made; plan it again." });
      const next = compile(body.document, headDesired());
      if (typeof next === "string") throw new DistrictApiError(422, { code: "validation-failed", message: next });
      if (plan(headDesired(), next).approvals.length > 0 && body.acknowledgeApprovals !== true) {
        throw new DistrictApiError(409, { code: "conflict", message: "The plan requires approvals; review them and apply again acknowledging them." });
      }
      const applied = revision(next, revisions.at(-1));
      revisions.push(applied);
      return applied as never;
    },
    "admin.previewRoster": () => rosterPreview(),
    "admin.applyRoster": () => ({ applied: true, preview: rosterPreview(), grantsRevoked: 1 }) as never,
    // Roster sync (SCHO-277): a Clever roster that syncs on a schedule, unless the options say otherwise.
    "admin.rosterSyncStatus": () => {
      if (options.rosterSync === "unreadable") throw new DistrictApiError(503, { code: "unavailable", message: "The roster sync record could not be read.", correlationId: "req-sync" });
      if (options.rosterSync === "not-runnable") {
        return { provider: "oneroster-api", runnable: false, reason: "this deployment has no roster source for oneroster-api", runs: [] } as never;
      }
      const latest = syncRuns.at(-1);
      const lastSuccess = syncRuns.findLast((run) => run.outcome === "succeeded");
      const failures = syncRuns.length - 1 - syncRuns.findLastIndex((run) => run.outcome === "succeeded");
      return {
        provider: "clever",
        runnable: true,
        runs: syncRuns,
        health: {
          status: failures > 0 ? "degraded" : "healthy",
          ...(lastSuccess === undefined ? {} : { lastSuccessAt: lastSuccess.finishedAt, stalenessMinutes: 20 }),
          consecutiveFailures: failures,
          ...(latest?.errorCode === undefined ? {} : { lastErrorCode: latest.errorCode }),
          quarantineBacklog: lastSuccess?.quarantined ?? 0,
        },
        ...(approvedRemoval === undefined ? {} : { approvedRemoval }),
      } as never;
    },
    "admin.runRosterSync": (input) => {
      if (options.rosterSync === "not-runnable") {
        throw new DistrictApiError(503, { code: "unavailable", message: "The roster cannot sync: this deployment has no roster source for oneroster-api.", correlationId: "req-sync" });
      }
      const mode = (input.body as { mode?: "complete" | "delta" }).mode ?? "complete";
      const at = new Date(Date.parse("2026-10-29T09:00:00.000Z") + syncRuns.length * 60_000).toISOString();
      const base = { id: `admin-req-${syncRuns.length + 1}`, mode, startedAt: at, finishedAt: at };
      if (options.rosterSync === "feed-rejected") {
        const run = { ...base, counts: syncCounts(), quarantined: 0, outcome: "failed", errorCode: "feed-rejected" } as SyncRun;
        syncRuns.push(run);
        return {
          ran: true, run, grantsRevoked: 0,
          preview: syncPreview([
            { severity: "error", file: "enrollments.csv", row: 14, column: "classSourcedId", sourcedId: "enr-14", message: "The enrollment names a class the feed does not list." },
            { severity: "warning", file: "demographics.csv", message: "demographics.csv is not read; it was skipped." },
          ]),
        } as never;
      }
      if (options.rosterSync === "removal-held" && approvedRemoval !== HELD_FINGERPRINT) {
        const run = {
          ...base, counts: syncCounts(), quarantined: 0, outcome: "failed", errorCode: "removal-held",
          held: { principals: { deactivated: 60, active: 96 }, enrollments: { deactivated: 60, active: 96 }, fingerprint: HELD_FINGERPRINT },
        } as SyncRun;
        syncRuns.push(run);
        return { ran: true, run, grantsRevoked: 0 } as never;
      }
      approvedRemoval = undefined;
      const run = {
        ...base, quarantined: 1, outcome: "succeeded",
        counts: syncCounts({
          principals: { added: 1, updated: 2, deactivated: 1 },
          enrollments: { added: 2, updated: 0, deactivated: 3 },
          ...(mode === "complete" ? { offerings: { added: 0, updated: 1, deactivated: 0 } } : {}),
        }),
      } as SyncRun;
      syncRuns.push(run);
      return {
        ran: true, run, grantsRevoked: 1,
        preview: syncPreview([{ severity: "warning", file: "users.csv", row: 12, column: "grades", sourcedId: "u-312", message: "The grade \"13\" is not a grade level; it was left out." }]),
      } as never;
    },
    "admin.approveRosterRemoval": (input) => {
      const { fingerprint } = input.body as { fingerprint: string };
      if (syncRuns.at(-1)?.held?.fingerprint !== fingerprint) {
        throw new DistrictApiError(409, { code: "conflict", message: "That is not the removal the latest roster sync held; review the latest sync again." });
      }
      approvedRemoval = fingerprint;
      return { approvedRemoval: fingerprint } as never;
    },
    "admin.termRollover": (input) => ({
      termId: (input.params as { termId: string }).termId,
      termState: "completed",
      alreadyClosed: false,
      canClose: true,
      offerings: 4,
      workspaces: { toRetain: 4, onLegalHold: 1 },
      grants: { toRevoke: 9 },
      principals: { students: 91, staff: 5 },
    }) as never,
    "admin.directoryNames": () => ({
      schools: Object.entries(SCHOOL_NAMES).map(([id, name]) => ({ id, name })),
      terms: [{ id: TERM.id, name: TERM.name }],
      offerings: CLASSES.map((c) => ({ id: c.offeringId, name: classTitle(c) })),
    }) as never,
    "admin.listOfferings": () => CLASSES.map((c) => ({ ...classRecords(c), teachers: TEACHERS.slice(0, c.staff), students: c.students })) as never,
    // Learning standards (SCHO-220): two built-in frameworks, neither approved at first.
    "admin.listStandards": () => standards as never,
    "admin.approveStandards": (input) => Object.assign(standardsFor(input), { status: "approved", decided: { by: "prn_fk-admin", at: "2026-10-25T15:00:00.000Z" } }) as never,
    "admin.withdrawStandards": (input) => Object.assign(standardsFor(input), { status: "not-approved", decided: { by: "prn_fk-admin", at: "2026-10-25T15:05:00.000Z" } }) as never,
    // Operations (SCHO-263): the enrolled admin keys and the district's ops log, kept in memory.
    "admin.opsKeys": () => ({ keys: opsKeys }) as never,
    "admin.enrollOpsKey": (input) => {
      const body = input.body as { registration: { adminOrigin: string; keyId: string; scopes: string[] }; scopes: string[]; label?: string };
      if (opsKeys.some((k) => k.keyId === body.registration.keyId && k.status === "enrolled")) {
        throw new DistrictApiError(409, { code: "conflict", message: "That admin key is already enrolled." });
      }
      const key = {
        keyId: body.registration.keyId,
        label: body.label ?? new URL(body.registration.adminOrigin).host,
        adminOrigin: body.registration.adminOrigin,
        scopes: body.scopes,
        requestedScopes: body.registration.scopes,
        enrolledAt: "2026-10-28T12:00:00.000Z",
        enrolledBy: { principalId: "prn_fk-admin", displayName: "Avery Admin" },
        status: "enrolled",
      };
      opsKeys.unshift(key);
      return key as never;
    },
    "admin.removeOpsKey": (input) => {
      const key = opsKeys.find((k) => k.keyId === (input.params as { keyId: string }).keyId && k.status === "enrolled");
      if (key === undefined) throw new DistrictApiError(404, { code: "not-found", message: "No such admin key is enrolled." });
      Object.assign(key, { status: "removed", removedAt: "2026-10-28T12:05:00.000Z" });
      return key as never;
    },
    "admin.opsAudit": () => ({ entries: opsAudit }) as never,
    // A route that names students. The aggregate screens must never call it.
    "teacher.roster": () => STUDENT_NAMES.map((displayName) => ({ displayName })) as never,
  };

  const client: DistrictApiClient = {
    async call<N extends RouteName>(name: N, ...args: CallArgs<N>): Promise<RouteResponse<N>> {
      const input = (args[0] ?? {}) as Record<string, unknown>;
      calls.push({ name, input });
      if (options.caller === "unlinked") {
        throw new DistrictApiError(401, { code: "unauthenticated", message: "This sign-in is not linked to a principal in this district.", unlinkedSignIn: UNLINKED_SIGN_IN });
      }
      if (options.caller === "not-administrator" && name.startsWith("admin.")) {
        throw new DistrictApiError(403, { code: "forbidden", message: "Only a district administrator can do this.", correlationId: "req-fake" });
      }
      const handler = handlers[name] as ((input: Record<string, unknown>) => RouteResponse<N>) | undefined;
      if (handler === undefined) throw new DistrictApiError(404, { code: "not-found", message: `The fake district has no ${name}.` });
      // A structured copy, as JSON over the wire would be, so the console cannot share state with the fake.
      return structuredClone(handler(input));
    },
  };
  return { client, calls, revisions, allocationRevisions };
}
