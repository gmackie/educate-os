// A scripted district API client for the console's journey tests: an in-memory district with four
// classes, a configuration history and a roster import, answering the admin routes the way the
// district app does in the cases the tests exercise. Plans are computed from the documents the
// console sends, so a test sees the consequences of what it clicked; `configDocument.test.ts`
// checks the same documents against the real district app. Not a test file: vitest collects only
// `*.test.*`.
import { DistrictApiError, type CallArgs, type DistrictApiClient, type RouteName, type RouteResponse } from "@schoolos/api-client";
import { POLICY_ORDERINGS, type ConfigurationRevision, type PolicySettings } from "@schoolos/contracts";
import type { ConfigurationPlan, DiffEntry } from "../app/useDistrictConfig.ts";
import type { DesiredStateView } from "../configDocument.ts";

/** A synthetic class. */
export interface FakeClass {
  offeringId: string;
  schoolId: string;
  students: number;
  staff: number;
}

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
    apiVersion: "schoolos.dev/v1alpha1",
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
    .filter((key) => (POLICY_ORDERINGS[key] as readonly string[]).indexOf(next.policies[key]) < (POLICY_ORDERINGS[key] as readonly string[]).indexOf(current.policies[key]))
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

const totals = (requests: number, cents: number) => ({
  requests, inputTokens: requests * 200, outputTokens: requests * 100, cacheReadTokens: 0, cacheWriteTokens: 0, usageCents: cents, adjustmentCents: 0, totalCents: cents,
});

/** The fake district: the client the console is given, and what it was asked. */
export interface FakeDistrict {
  /** The client. */
  client: DistrictApiClient;
  /** Every route called, in order, with its input. */
  calls: { name: RouteName; input: unknown }[];
  /** The revisions applied, oldest first. */
  revisions: ConfigurationRevision[];
}

/** A fresh fake district whose first configuration has every module off. */
export function fakeDistrict(): FakeDistrict {
  const calls: FakeDistrict["calls"] = [];
  let sequence = 1;
  const revision = (desired: DesiredStateView, previous?: ConfigurationRevision): ConfigurationRevision => ({
    id: `cfg_fake-${sequence++}` as ConfigurationRevision["id"],
    scope: { districtId: "dst_fake" as never },
    schemaVersion: "schoolos.dev/v1alpha1",
    desired,
    status: "applied",
    actorPrincipalId: "prn_fk-admin" as never,
    ...(previous === undefined ? {} : { previousRevisionId: previous.id }),
  });
  const revisions = [revision(initialDesired())];
  const headDesired = () => revisions.at(-1)!.desired as DesiredStateView;

  const handlers: { [N in RouteName]?: (input: Record<string, unknown>) => RouteResponse<N> } = {
    "me.get": () => ({ principalId: "prn_fk-admin", districtId: "dst_fake", kind: "staff", displayName: "Avery Admin", roles: [], enrollments: [] }) as never,
    "admin.health": () => ({
      districtId: "dst_fake",
      directory: { schools: 2, terms: 1, offerings: CLASSES.length, students: 91, staff: 5, activeEnrollments: 96 },
      work: { workspaces: 12, artifacts: 30, submissions: 8, installedActivities: 4 },
      content: { awaitingReview: 3, releases: 2 },
      config: { headRevisionId: revisions.at(-1)!.id, revisions: revisions.length },
      aiRequests: 41,
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
    // A route that names students. The aggregate screens must never call it.
    "teacher.roster": () => STUDENT_NAMES.map((displayName) => ({ displayName })) as never,
  };

  const client: DistrictApiClient = {
    async call<N extends RouteName>(name: N, ...args: CallArgs<N>): Promise<RouteResponse<N>> {
      const input = (args[0] ?? {}) as Record<string, unknown>;
      calls.push({ name, input });
      const handler = handlers[name] as ((input: Record<string, unknown>) => RouteResponse<N>) | undefined;
      if (handler === undefined) throw new DistrictApiError(404, { code: "not-found", message: `The fake district has no ${name}.` });
      // A structured copy, as JSON over the wire would be, so the console cannot share state with the fake.
      return structuredClone(handler(input));
    },
  };
  return { client, calls, revisions };
}
