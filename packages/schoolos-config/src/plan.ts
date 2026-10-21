import {
  POLICY_ORDERINGS,
  PolicySettings,
  SCOPE_LEVELS,
  SchoolOsError,
  resolvePolicy,
  scopeContains,
  type CapabilityActivationState,
  type CapabilityId,
  type ConfigurationRevision,
  type CourseOffering,
  type DistrictDirectorySnapshot,
  type OfferingId,
  type PolicyLayer,
  type PolicyOverrides,
  type PolicyViolation,
  type SchoolId,
  type Scope,
} from "@schoolos/contracts";
import { canonicalJson } from "./canonical.ts";
import { DEFAULTS_PROFILES, DesiredState, type DesiredModule, type ModuleState } from "./document.ts";
import { formFields } from "./forms.ts";
import { resolveDependencies, type CapabilityRegistry, type ResolutionProblem } from "./registry.ts";
import { diffDesired, type DiffEntry } from "./revisions.ts";
import { pointerSegment } from "./secrets.ts";

/** A pack's activation under one desired state. */
export interface PackActivation {
  /** Installed, enabled, or enabled and exposed to at least one offering. */
  state: CapabilityActivationState;
  /** The module state the configuration asked for. */
  mode: ModuleState;
  /** The pinned version. */
  version: string;
  /** The offerings the pack is exposed to, sorted. */
  exposedTo: OfferingId[];
}

/** What changes about one pack. */
export type PackChangeKind =
  | "installed"
  | "uninstalled"
  | "enabled"
  | "disabled"
  | "mode-changed"
  | "version-changed"
  | "config-changed"
  | "exposure-changed";

/** One pack whose activation, version, configuration or exposure changes. */
export interface PackChange {
  /** The pack. */
  capabilityId: CapabilityId;
  /** Its activation now; absent when not installed. */
  before?: PackActivation;
  /** Its activation after the change; absent when uninstalled. */
  after?: PackActivation;
  /** Every kind of change, in a fixed order. */
  changes: PackChangeKind[];
  /** Offerings newly exposed to the pack. */
  exposedTo: OfferingId[];
  /** Offerings the pack is withdrawn from. */
  withdrawnFrom: OfferingId[];
}

/** A pack whose activation changes only because something that depends on it was turned on. */
export interface DependencyEffect {
  /** The pack pulled in. */
  capabilityId: CapabilityId;
  /** The packs that need it. */
  pulledInBy: CapabilityId[];
  /** Its activation after the change. */
  state: CapabilityActivationState;
}

/** Where an effective setting's value came from, widest first. */
export type PolicySource = "profile" | "district" | "school" | "offering";

/** The policy in force at an offering, with where each setting was inherited from. */
export interface OfferingPolicy {
  /** The effective settings. */
  effective: PolicySettings;
  /** The level that set each effective value. */
  sources: Record<keyof PolicySettings, PolicySource>;
}

/** The people an offering-level change reaches. */
export interface OfferingImpact {
  /** The offering. */
  offeringId: OfferingId;
  /** Its school. */
  schoolId: SchoolId;
  /** Distinct students with an active enrollment. */
  students: number;
  /** Distinct teachers and co-teachers with an active enrollment. */
  staff: number;
  /** Packs newly exposed to the offering. */
  packsExposed: CapabilityId[];
  /** Packs withdrawn from the offering. */
  packsWithdrawn: CapabilityId[];
  /** Whether the offering's effective policy changes. */
  policyChanged: boolean;
  /** The offering's effective policy after the change. */
  policy: OfferingPolicy;
}

/** Why a change needs a district administrator's approval before it is applied. */
export type ApprovalReason =
  | "policy-loosened"
  | "ai-capability-enabled"
  | "governed-setting-enabled"
  | "admin-activation-removed"
  | "exposure-activation";

/** An approval the change requires. Loosening AI or privacy always needs a district administrator. */
export interface RequiredApproval {
  /** Who must approve. */
  role: "district-admin";
  /** Why. */
  reason: ApprovalReason;
  /** JSON Pointer into the next desired state. */
  path: string;
  /** What is being approved, for the approval screen. */
  detail: string;
}

/** A policy violation, placed at the offering whose resolution found it. */
export interface ScopedPolicyViolation extends PolicyViolation {
  /** The offering being resolved. */
  offeringId: OfferingId;
}

/** A reason the next revision cannot be applied to this district as it stands. */
export interface PlanProblem {
  /** What the problem is. */
  code: "unknown-offering" | "offering-term-closed" | "unknown-scope" | "pack-version-unavailable" | ResolutionProblem["kind"];
  /** JSON Pointer into the next desired state. */
  path: string;
  /** Safe to show an administrator. */
  message: string;
}

/** A dry run: everything applying `next` over `current` would change, and what stands in its way. */
export interface ConfigurationPlan {
  /** The structural diff of the desired states. */
  diff: DiffEntry[];
  /** The next state's packs, dependencies first. Empty when there are resolution problems. */
  installOrder: CapabilityId[];
  /** Packs whose activation, version, configuration or exposure changes, by ID. */
  packs: PackChange[];
  /** Packs whose activation changes only because a dependent needs them. */
  dependencyEffects: DependencyEffect[];
  /** Offerings whose exposure or effective policy changes, by ID. */
  offerings: OfferingImpact[];
  /** Overrides that would loosen the floor at some offering. */
  policyViolations: ScopedPolicyViolation[];
  /** Approvals required before applying. */
  approvals: RequiredApproval[];
  /** Problems that block applying. */
  problems: PlanProblem[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const POLICY_KEYS = [...Object.keys(POLICY_ORDERINGS), "aiMonthlyCapCentsPerPrincipal"] as (keyof PolicySettings)[];

function isLooser(key: keyof PolicySettings, from: unknown, to: unknown): boolean {
  if (key === "aiMonthlyCapCentsPerPrincipal") return (to as number) > (from as number);
  const order: readonly unknown[] = POLICY_ORDERINGS[key];
  return order.indexOf(to) < order.indexOf(from);
}

function parseDesired(revision: ConfigurationRevision): DesiredState {
  const parsed = DesiredState.safeParse(revision.desired);
  if (!parsed.success) throw new SchoolOsError("validation-failed", `revision ${revision.id} does not hold a valid desired state`);
  return parsed.data;
}

function offeringScope(offering: CourseOffering): Scope {
  return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
}

/** The offerings a desired state exposes packs to, and any reference the directory cannot satisfy. */
function exposureTargets(
  desired: DesiredState,
  directory: DistrictDirectorySnapshot,
  problems: PlanProblem[] | undefined,
): OfferingId[] {
  const termState = new Map(directory.terms.map((term) => [term.id, term.state]));
  if (desired.rollout.target === "all-active-offerings") {
    return directory.offerings.filter((o) => termState.get(o.termId) === "active").map((o) => o.id).toSorted(byId);
  }
  const offerings = new Map(directory.offerings.map((o) => [o.id, o]));
  return desired.rollout.offerings.filter((id, index) => {
    const offering = offerings.get(id);
    const path = `/rollout/offerings/${index}`;
    if (offering === undefined) {
      problems?.push({ code: "unknown-offering", path, message: `${id} is not an offering in this district` });
      return false;
    }
    const state = termState.get(offering.termId);
    if (state !== "planned" && state !== "active") {
      problems?.push({ code: "offering-term-closed", path, message: `${id} is in a ${state ?? "missing"} term and cannot gain new packs` });
      return false;
    }
    return true;
  });
}

function activations(
  desired: DesiredState | undefined,
  directory: DistrictDirectorySnapshot,
  registry: CapabilityRegistry,
  problems?: PlanProblem[],
): Map<CapabilityId, PackActivation> {
  const result = new Map<CapabilityId, PackActivation>();
  if (desired === undefined) return result;
  const targets = exposureTargets(desired, directory, problems);
  for (const [id, module] of Object.entries(desired.modules) as [CapabilityId, DesiredModule][]) {
    const active = module.state !== "disabled";
    const exposable = registry.packs.get(id)?.manifest.supportedScopes.includes("offering") ?? false;
    const exposedTo = active && exposable ? targets : [];
    result.set(id, {
      state: exposedTo.length > 0 ? "exposed" : active ? "enabled" : "installed",
      mode: module.state,
      version: module.version,
      exposedTo,
    });
  }
  return result;
}

function offeringPolicy(desired: DesiredState, offering: CourseOffering, violations?: ScopedPolicyViolation[]): OfferingPolicy {
  const target = offeringScope(offering);
  const containing = desired.overrides.filter((o) => scopeContains(o.scope, target));
  const layers: PolicyLayer[] = containing.map((o) => ({ level: o.scope.level as PolicyLayer["level"], settings: o.settings }));
  const profile: PolicySettings = DEFAULTS_PROFILES[desired.profile];
  const sources = Object.fromEntries(POLICY_KEYS.map((key) => [
    key,
    desired.policies[key] === profile[key] ? "profile" : "district",
  ])) as Record<keyof PolicySettings, PolicySource>;
  const resolution = resolvePolicy(desired.policies, layers);
  if (!resolution.ok) violations?.push(...resolution.violations.map((v) => ({ ...v, offeringId: offering.id })));
  // Re-resolve without the refused settings, so the reported policy is what would actually apply.
  const refused = resolution.ok ? [] : resolution.violations;
  const allowed = layers.map((layer) => ({
    ...layer,
    settings: Object.fromEntries(Object.entries(layer.settings).filter(([key]) =>
      !refused.some((v) => v.level === layer.level && v.key === key)
    )) as PolicyOverrides,
  }));
  const effective = resolvePolicy(desired.policies, allowed);
  if (!effective.ok) throw new Error("unreachable: refused settings were removed");
  // Only school and offering overrides contain an offering's scope.
  for (const layer of allowed.toSorted((a, b) => SCOPE_LEVELS.indexOf(a.level) - SCOPE_LEVELS.indexOf(b.level))) {
    if (layer.level === "activity") continue;
    for (const key of Object.keys(layer.settings) as (keyof PolicySettings)[]) sources[key] = layer.level;
  }
  return { effective: effective.effective, sources };
}

function countPrincipals(directory: DistrictDirectorySnapshot, offeringId: OfferingId) {
  const students = new Set<string>();
  const staff = new Set<string>();
  for (const enrollment of directory.enrollments) {
    if (enrollment.offeringId !== offeringId || enrollment.status !== "active") continue;
    (enrollment.role === "student" ? students : staff).add(enrollment.principalId);
  }
  return { students: students.size, staff: staff.size };
}

function packChanges(
  before: PackActivation | undefined,
  after: PackActivation | undefined,
  beforeModule: DesiredModule | undefined,
  afterModule: DesiredModule | undefined,
): PackChangeKind[] {
  const changes: PackChangeKind[] = [];
  if (before === undefined && after !== undefined) changes.push("installed");
  if (before !== undefined && after === undefined) changes.push("uninstalled");
  const wasActive = before !== undefined && before.state !== "installed";
  const isActive = after !== undefined && after.state !== "installed";
  if (!wasActive && isActive) changes.push("enabled");
  if (wasActive && !isActive) changes.push("disabled");
  if (wasActive && isActive && before.mode !== after.mode) changes.push("mode-changed");
  if (before !== undefined && after !== undefined && before.version !== after.version) changes.push("version-changed");
  if (beforeModule !== undefined && afterModule !== undefined
    && canonicalJson(beforeModule.config) !== canonicalJson(afterModule.config)) {
    changes.push("config-changed");
  }
  if (canonicalJson(before?.exposedTo ?? []) !== canonicalJson(after?.exposedTo ?? [])) changes.push("exposure-changed");
  return changes;
}

/**
 * Plans applying `next` over `current` (absent for a district's first revision) to the district in
 * `directory`. Nothing is changed: the plan reports what would be installed, enabled and exposed and
 * where, what dependencies pull in, how many people each affected offering reaches, the effective
 * policy at each offering and where every setting is inherited from, policy violations, the
 * approvals required, and any problem that blocks applying.
 */
export function planConfigurationChange(input: {
  current?: ConfigurationRevision;
  next: ConfigurationRevision;
  directory: DistrictDirectorySnapshot;
  registry: CapabilityRegistry;
}): ConfigurationPlan {
  const { directory, registry } = input;
  const next = parseDesired(input.next);
  const current = input.current === undefined ? undefined : parseDesired(input.current);
  if (next.district !== directory.district.id || (current !== undefined && current.district !== next.district)) {
    throw new SchoolOsError("conflict", "the revisions and the directory must belong to the same district");
  }

  const problems: PlanProblem[] = [];
  const resolution = resolveDependencies(registry, Object.keys(next.modules) as CapabilityId[]);
  problems.push(...resolution.problems.map((problem): PlanProblem => ({
    code: problem.kind,
    path: `/modules/${"capabilityId" in problem ? problem.capabilityId : problem.path[0]}`,
    message: `the next revision's packs no longer resolve (${problem.kind})`,
  })));
  for (const [id, module] of Object.entries(next.modules)) {
    const available = registry.packs.get(id as CapabilityId)?.manifest.version;
    if (available !== undefined && available !== module.version) {
      problems.push({
        code: "pack-version-unavailable",
        path: `/modules/${id}/version`,
        message: `${id} ${module.version} is pinned but ${available} is the version available`,
      });
    }
  }
  const knownSchools = new Set(directory.schools.map((s) => s.id));
  const knownOfferings = new Set(directory.offerings.map((o) => o.id));
  next.overrides.forEach(({ scope }, index) => {
    const unknown = !knownSchools.has(scope.schoolId)
      || ("offeringId" in scope && !knownOfferings.has(scope.offeringId));
    if (unknown) problems.push({ code: "unknown-scope", path: `/overrides/${index}/scope`, message: "the override names a school or offering not in this district" });
  });

  const before = activations(current, directory, registry);
  const after = activations(next, directory, registry, problems);

  const packs: PackChange[] = [];
  const dependencyEffects: DependencyEffect[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].toSorted(byId)) {
    const was = before.get(id);
    const will = after.get(id);
    const changes = packChanges(was, will, current?.modules[id], next.modules[id]);
    if (changes.length === 0) continue;
    const exposedTo = (will?.exposedTo ?? []).filter((o) => !(was?.exposedTo ?? []).includes(o));
    const withdrawnFrom = (was?.exposedTo ?? []).filter((o) => !(will?.exposedTo ?? []).includes(o));
    packs.push({
      capabilityId: id,
      ...(was === undefined ? {} : { before: was }),
      ...(will === undefined ? {} : { after: will }),
      changes,
      exposedTo,
      withdrawnFrom,
    });
    const requiredBy = next.modules[id]?.requiredBy;
    if (requiredBy !== undefined && will !== undefined && (changes.includes("installed") || changes.includes("enabled"))) {
      dependencyEffects.push({ capabilityId: id, pulledInBy: requiredBy, state: will.state });
    }
  }

  const policyViolations: ScopedPolicyViolation[] = [];
  const offerings: OfferingImpact[] = [];
  const loosenedAt: { offeringId: OfferingId; key: keyof PolicySettings; from: unknown; to: unknown }[] = [];
  for (const offering of directory.offerings.toSorted((a, b) => byId(a.id, b.id))) {
    const policy = offeringPolicy(next, offering, policyViolations);
    const previous = current === undefined ? undefined : offeringPolicy(current, offering);
    const baseline = previous?.effective ?? DEFAULTS_PROFILES[next.profile];
    for (const key of POLICY_KEYS) {
      if (isLooser(key, baseline[key], policy.effective[key])) {
        loosenedAt.push({ offeringId: offering.id, key, from: baseline[key], to: policy.effective[key] });
      }
    }
    const packsExposed = packs.filter((p) => p.exposedTo.includes(offering.id)).map((p) => p.capabilityId);
    const packsWithdrawn = packs.filter((p) => p.withdrawnFrom.includes(offering.id)).map((p) => p.capabilityId);
    const policyChanged = previous !== undefined && canonicalJson(previous.effective) !== canonicalJson(policy.effective);
    if (packsExposed.length === 0 && packsWithdrawn.length === 0 && !policyChanged) continue;
    offerings.push({
      offeringId: offering.id,
      schoolId: offering.schoolId,
      ...countPrincipals(directory, offering.id),
      packsExposed,
      packsWithdrawn,
      policyChanged,
      policy,
    });
  }

  return {
    diff: diffDesired(current, next),
    installOrder: resolution.installOrder,
    packs,
    dependencyEffects,
    offerings,
    policyViolations,
    approvals: requiredApprovals(current, next, packs, offerings, loosenedAt, registry),
    problems,
  };
}

function requiredApprovals(
  current: DesiredState | undefined,
  next: DesiredState,
  packs: readonly PackChange[],
  offerings: readonly OfferingImpact[],
  loosenedAt: readonly { offeringId: OfferingId; key: keyof PolicySettings; from: unknown; to: unknown }[],
  registry: CapabilityRegistry,
): RequiredApproval[] {
  const approvals: RequiredApproval[] = [];
  const approve = (reason: ApprovalReason, path: string, detail: string) =>
    approvals.push({ role: "district-admin", reason, path, detail });

  // The floor is compared with the previous floor, or with the profile for a first revision.
  const baseline: PolicySettings = current?.policies ?? DEFAULTS_PROFILES[next.profile];
  const floorLoosened = new Set<keyof PolicySettings>();
  for (const key of POLICY_KEYS) {
    if (!isLooser(key, baseline[key], next.policies[key])) continue;
    floorLoosened.add(key);
    approve("policy-loosened", `/policies/${key}`, `district ${key}: ${String(baseline[key])} -> ${String(next.policies[key])}`);
  }
  // An offering can also loosen when a narrower override that tightened it is relaxed or removed.
  for (const { offeringId, key, from, to } of loosenedAt) {
    if (floorLoosened.has(key)) continue;
    approve("policy-loosened", "/overrides", `${offeringId} ${key}: ${String(from)} -> ${String(to)}`);
  }

  for (const pack of packs) {
    const id = pack.capabilityId;
    const manifest = registry.packs.get(id)?.manifest;
    const nowActive = pack.after !== undefined && pack.after.state !== "installed";
    if (manifest === undefined || !nowActive) continue;
    if (pack.changes.includes("enabled") && manifest.requiredResources.includes("ai-gateway")) {
      approve("ai-capability-enabled", `/modules/${id}/state`, `${id} sends requests to AI providers`);
    }
    const wasActive = pack.before !== undefined && pack.before.state !== "installed";
    const beforeConfig = wasActive ? current?.modules[id]?.config ?? {} : {};
    const afterConfig = next.modules[id]!.config;
    for (const field of formFields(manifest.configSchema)) {
      if (field.governance === undefined || field.path.includes("[]")) continue;
      const segments = field.path.split(".");
      const read = (config: Record<string, unknown>) =>
        segments.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config);
      if (read(afterConfig) === true && read(beforeConfig) !== true) {
        approve(
          "governed-setting-enabled",
          `/modules/${id}/config/${segments.map(pointerSegment).join("/")}`,
          `${id}: ${field.label} (${field.governance})`,
        );
      }
    }
  }

  if (current?.rollout.requiresAdminActivation === true && !next.rollout.requiresAdminActivation) {
    approve("admin-activation-removed", "/rollout/requiresAdminActivation", "packs would reach offerings without district activation");
  }
  if (next.rollout.requiresAdminActivation) {
    for (const offering of offerings) {
      if (offering.packsExposed.length === 0) continue;
      approve("exposure-activation", "/rollout/offerings", `${offering.offeringId}: ${offering.packsExposed.join(", ")}`);
    }
  }
  return approvals;
}
