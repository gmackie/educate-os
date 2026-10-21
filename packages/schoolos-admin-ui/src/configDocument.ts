// The console edits the district's configuration the way the district API accepts it: as a whole
// `schoolos.dev/v1alpha1` document, planned and then applied. A revision stores the compiled
// desired state rather than the document, so this module reads a revision's desired state back into
// the document that compiles to it, and makes the edits the console offers (a module's state, the
// classes it is visible to, the district policy floor). Nothing here decides anything: every change
// is planned and validated by the district before it is applied.
import { z } from "zod";
import {
  CapabilityId,
  DistrictId,
  OfferingId,
  PolicyOverrides,
  PolicySettings,
  Scope,
  type ConfigurationRevision,
} from "@schoolos/contracts";

/** The configuration document version the console writes. */
export const CONFIG_API_VERSION = "schoolos.dev/v1alpha1";

/** A module's state in a configuration document. */
export const ModuleState = z.enum(["enabled", "advisory", "disabled"]);
/** A module state. */
export type ModuleState = z.infer<typeof ModuleState>;

/**
 * A revision's desired state, as the console reads it. It mirrors the district's compiled desired
 * state (`DesiredState` in `@schoolos/config`), which the routes carry only as an untyped record.
 */
export const DesiredStateView = z.strictObject({
  apiVersion: z.literal(CONFIG_API_VERSION),
  district: DistrictId,
  profile: z.string().min(1),
  identity: z.record(z.string(), z.unknown()),
  rostering: z.strictObject({ provider: z.string().min(1), mode: z.string().min(1) }),
  curriculum: z.record(z.string(), z.unknown()).optional(),
  modules: z.record(CapabilityId, z.strictObject({
    state: ModuleState,
    version: z.string(),
    config: z.record(z.string(), z.unknown()),
    /** Present when the module was pulled in only because these modules need it. */
    requiredBy: z.array(CapabilityId).optional(),
  })),
  rollout: z.strictObject({
    target: z.enum(["selected-course-offerings", "all-active-offerings"]),
    offerings: z.array(OfferingId),
    requiresAdminActivation: z.boolean(),
  }),
  policies: PolicySettings,
  overrides: z.array(z.strictObject({ scope: Scope, settings: PolicyOverrides })),
});
/** A revision's desired state as the console reads it. */
export type DesiredStateView = z.infer<typeof DesiredStateView>;
/** One module of a desired state. */
export type DesiredModule = DesiredStateView["modules"][CapabilityId];

/** A district configuration document, as the plan and apply routes accept it. */
export type ConfigDocument = Record<string, unknown>;

/** Reads a revision's desired state, or throws if the district returned something the console cannot read. */
export function readDesired(revision: ConfigurationRevision): DesiredStateView {
  const parsed = DesiredStateView.safeParse(revision.desired);
  if (!parsed.success) throw new Error("This configuration version is in a format the console cannot read.");
  return parsed.data;
}

/** Policy in the document vocabulary, from settings in the contract vocabulary. */
function policyDocument(settings: PolicyOverrides): Record<string, unknown> {
  const ai: Record<string, unknown> = {};
  if (settings.aiSpending !== undefined) ai.spending = settings.aiSpending;
  if (settings.promptsInGatewayLogs !== undefined) ai.promptsInGatewayLogs = settings.promptsInGatewayLogs === "permitted";
  if (settings.aiMonthlyCapCentsPerPrincipal !== undefined) ai.monthlyCapCentsPerPrincipal = settings.aiMonthlyCapCentsPerPrincipal;
  return {
    ...(Object.keys(ai).length > 0 ? { ai } : {}),
    ...(settings.studentPersonalConversations === undefined ? {} : { studentPersonalConversations: settings.studentPersonalConversations }),
    ...(settings.teacherObservation === undefined ? {} : { teacherObservation: settings.teacherObservation }),
    ...(settings.automatedSelProfiling === undefined ? {} : { automatedSelProfiling: settings.automatedSelProfiling }),
  };
}

/**
 * The document a desired state was compiled from, up to what compiling fills in: modules pulled in
 * only as dependencies are left for the compiler to pull in again, and the policy floor is written
 * out in full.
 */
export function documentFromDesired(desired: DesiredStateView): ConfigDocument {
  const modules = Object.fromEntries(Object.entries(desired.modules)
    .filter(([, module]) => module.requiredBy === undefined)
    .map(([id, module]) => [id, { state: module.state, config: module.config }]));
  const { target, offerings, requiresAdminActivation } = desired.rollout;
  return {
    apiVersion: desired.apiVersion,
    district: desired.district,
    profile: desired.profile,
    identity: desired.identity,
    rostering: desired.rostering,
    ...(desired.curriculum === undefined ? {} : { curriculum: desired.curriculum }),
    modules,
    rollout: target === "all-active-offerings" ? { target, requiresAdminActivation } : { target, offerings, requiresAdminActivation },
    policies: policyDocument(desired.policies),
    overrides: desired.overrides.map((override) => ({ scope: override.scope, policies: policyDocument(override.settings) })),
  };
}

/** The desired state with one module set to `state`. A module not yet listed is added with its default configuration. */
export function withModuleState(desired: DesiredStateView, capabilityId: CapabilityId, state: ModuleState): DesiredStateView {
  const current = desired.modules[capabilityId];
  return {
    ...desired,
    modules: {
      ...desired.modules,
      // Listing it explicitly, even if it was pulled in, keeps the administrator's choice once the dependent goes.
      [capabilityId]: { state, version: current?.version ?? "", config: current?.config ?? {} },
    },
  };
}

/** The desired state with its modules made visible to exactly these classes. */
export function withRolloutClasses(desired: DesiredStateView, offerings: readonly OfferingId[]): DesiredStateView {
  return {
    ...desired,
    rollout: { ...desired.rollout, target: "selected-course-offerings", offerings: [...new Set(offerings)].toSorted() },
  };
}

/** The desired state with a new district policy floor. */
export function withDistrictPolicies(desired: DesiredStateView, policies: PolicySettings): DesiredStateView {
  return { ...desired, policies };
}
