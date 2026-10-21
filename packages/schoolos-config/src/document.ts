import {
  CapabilityId,
  DistrictId,
  OfferingId,
  POLICY_ORDERINGS,
  PolicyOverrides,
  PolicySettings,
  Scope,
  SemVer,
} from "@schoolos/contracts";
import { z } from "zod";

/** The `apiVersion` of the district configuration document this package compiles. */
export const CONFIG_API_VERSION = "schoolos.dev/v1alpha1";

/**
 * Named policy defaults a document starts from. Every profile prohibits automated SEL profiling
 * (ADR-0004); they differ in how much AI spend and teacher visibility they allow.
 */
export const DEFAULTS_PROFILES = {
  "us-k12-conservative": {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 200,
  },
  "us-k12-standard": {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-and-shared-conversations",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 500,
  },
} as const satisfies Record<string, PolicySettings>;

/** The name of a defaults profile. */
export const DefaultsProfileName = z.enum(Object.keys(DEFAULTS_PROFILES) as [keyof typeof DEFAULTS_PROFILES]);
/** A defaults profile name. */
export type DefaultsProfileName = z.infer<typeof DefaultsProfileName>;

/**
 * A module's state in a document. `disabled` keeps the pack installed but off; `advisory` turns it
 * on with no official effect, for packs that support that.
 */
export const ModuleState = z.enum(["enabled", "advisory", "disabled"]);
/** A module state. */
export type ModuleState = z.infer<typeof ModuleState>;

/** A module entry: the state alone, or the state with pack configuration. */
export const ModuleEntry = z.union([
  ModuleState,
  z.strictObject({ state: ModuleState, config: z.record(z.string(), z.unknown()).optional() }),
]);
/** A module entry. */
export type ModuleEntry = z.infer<typeof ModuleEntry>;

/**
 * Policy as an administrator writes it. Every field is optional: the district level falls back to
 * its profile, and a narrower level inherits what it omits.
 */
export const PolicyDocument = z.strictObject({
  ai: z.strictObject({
    spending: z.enum(POLICY_ORDERINGS.aiSpending).optional(),
    /** Whether AI Gateway may log prompts. */
    promptsInGatewayLogs: z.boolean().optional(),
    monthlyCapCentsPerPrincipal: z.int().nonnegative().optional(),
  }).optional(),
  studentPersonalConversations: z.enum(POLICY_ORDERINGS.studentPersonalConversations).optional(),
  teacherObservation: z.enum(POLICY_ORDERINGS.teacherObservation).optional(),
  automatedSelProfiling: z.enum(POLICY_ORDERINGS.automatedSelProfiling).optional(),
});
/** A policy document. */
export type PolicyDocument = z.infer<typeof PolicyDocument>;

/** Translates a policy document into the contract vocabulary, omitting what it does not set. */
export function toPolicyOverrides(policies: PolicyDocument): PolicyOverrides {
  const overrides: PolicyOverrides = {};
  if (policies.ai?.spending !== undefined) overrides.aiSpending = policies.ai.spending;
  if (policies.ai?.promptsInGatewayLogs !== undefined) {
    overrides.promptsInGatewayLogs = policies.ai.promptsInGatewayLogs ? "permitted" : "prohibited";
  }
  if (policies.ai?.monthlyCapCentsPerPrincipal !== undefined) {
    overrides.aiMonthlyCapCentsPerPrincipal = policies.ai.monthlyCapCentsPerPrincipal;
  }
  if (policies.studentPersonalConversations !== undefined) {
    overrides.studentPersonalConversations = policies.studentPersonalConversations;
  }
  if (policies.teacherObservation !== undefined) overrides.teacherObservation = policies.teacherObservation;
  if (policies.automatedSelProfiling !== undefined) overrides.automatedSelProfiling = policies.automatedSelProfiling;
  return overrides;
}

/** A school, offering or activity scope: the levels that may tighten the district floor. */
export const NarrowerScope = Scope.refine((scope) => scope.level !== "district", {
  message: "an override names a school, offering or activity",
});
/** A narrower scope. */
export type NarrowerScope = z.infer<typeof NarrowerScope>;

const Rollout = z.strictObject({
  target: z.enum(["selected-course-offerings", "all-active-offerings"]),
  /** The offerings exposed to, when `target` is `selected-course-offerings`. */
  offerings: z.array(OfferingId).optional(),
  /** Whether exposing a pack to an offering waits for a district administrator to activate it. */
  requiresAdminActivation: z.boolean(),
});

const Curriculum = z.strictObject({
  frameworks: z.array(z.enum(["CCSS", "NGSS", "C3", "CASEL", "TEKS", "MI-K12"])).min(1),
  importedSources: z.array(z.enum(["district-approved", "schoolos-catalog"])).min(1),
});

const Identity = z.strictObject({ provider: z.enum(["district-sso", "cloudflare-access"]) });

const Rostering = z.strictObject({
  provider: z.enum(["oneroster-csv", "oneroster-api", "manual"]),
  mode: z.enum(["preview-before-apply", "apply-automatically"]),
});

/**
 * The declarative district configuration (roadmap §4.1), parsed from JSON or from YAML converted to
 * JSON by the caller. Unknown fields are rejected. Credentials never belong here; see `secrets.ts`.
 */
export const DistrictConfigDocument = z.strictObject({
  apiVersion: z.literal(CONFIG_API_VERSION),
  district: DistrictId,
  profile: DefaultsProfileName,
  identity: Identity,
  rostering: Rostering,
  curriculum: Curriculum.optional(),
  modules: z.record(CapabilityId, ModuleEntry),
  rollout: Rollout,
  policies: PolicyDocument.default({}),
  /** Narrower policy, each naming its full scope so no lookup is needed to place it. */
  overrides: z.array(z.strictObject({ scope: NarrowerScope, policies: PolicyDocument })).default([]),
}).superRefine((document, context) => {
  const selected = document.rollout.target === "selected-course-offerings";
  if (selected && (document.rollout.offerings ?? []).length === 0) {
    context.addIssue({ code: "custom", path: ["rollout", "offerings"], message: "name at least one offering" });
  }
  if (!selected && document.rollout.offerings !== undefined) {
    context.addIssue({ code: "custom", path: ["rollout", "offerings"], message: "offerings apply only to selected-course-offerings" });
  }
});
/** A district configuration document. */
export type DistrictConfigDocument = z.infer<typeof DistrictConfigDocument>;

/** A module after compilation: its pinned version and full configuration. */
export const DesiredModule = z.strictObject({
  state: ModuleState,
  version: SemVer,
  /** The pack configuration with every default filled in. */
  config: z.record(z.string(), z.unknown()),
  /** Present when the document did not list the pack and it was pulled in by these dependents. */
  requiredBy: z.array(CapabilityId).optional(),
});
/** A compiled module. */
export type DesiredModule = z.infer<typeof DesiredModule>;

/**
 * The normalized desired state a configuration revision stores: modules expanded and version-pinned,
 * the policy floor in the contract vocabulary, and lists sorted where order carries no meaning. Two
 * documents that mean the same thing compile to the same desired state, and so to the same hash.
 */
export const DesiredState = z.strictObject({
  apiVersion: z.literal(CONFIG_API_VERSION),
  district: DistrictId,
  profile: DefaultsProfileName,
  identity: Identity,
  rostering: Rostering,
  curriculum: Curriculum.optional(),
  modules: z.record(CapabilityId, DesiredModule),
  rollout: z.strictObject({
    target: Rollout.shape.target,
    offerings: z.array(OfferingId),
    requiresAdminActivation: z.boolean(),
  }),
  /** The complete district floor. */
  policies: PolicySettings,
  overrides: z.array(z.strictObject({ scope: NarrowerScope, settings: PolicyOverrides })),
});
/** A compiled desired state. */
export type DesiredState = z.infer<typeof DesiredState>;
