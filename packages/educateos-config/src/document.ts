import {
  CapabilityId,
  ClassLinkRosterConnection,
  ClassLinkSso,
  CleverRosterConnection,
  DistrictId,
  OfferingId,
  POLICY_ORDERINGS,
  PolicyOverrides,
  PolicySettings,
  RemovalHold,
  RosterIdentityMapping,
  RosterSyncSchedule,
  Scope,
  SemVer,
} from "@educateos/contracts";
import { z } from "zod";
import { parseRange } from "./semver.ts";

/** The `apiVersion` of the district configuration document this package compiles. */
export const CONFIG_API_VERSION = "educateos.io/v1alpha1";

/** SCHO-232: the `apiVersion` of documents and desired states written before the EducateOS rename. */
export const LEGACY_CONFIG_API_VERSION = "schoolos.dev/v1alpha1"; // rename-educateos: keep

/** SCHO-232: the names the EducateOS rename changed inside a document or desired state, old to new. */
const RENAMED_PACKS: Readonly<Record<string, string>> = { "schoolos-lti": "educateos-lti" }; // rename-educateos: keep
const RENAMED_SOURCES: Readonly<Record<string, string>> = { "schoolos-catalog": "educateos-catalog" }; // rename-educateos: keep

/**
 * A document or desired state with the names it may carry from before the EducateOS rename
 * (SCHO-232) read as the current ones: the `apiVersion`, the LTI pack's ID and the catalog's
 * imported-source name. Stored revisions keep what they hold, so their content hashes and IDs
 * still verify; what is compiled or rolled back from them is written with the current names.
 */
function withCurrentNames(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = { ...value };
  if (out.apiVersion === LEGACY_CONFIG_API_VERSION) out.apiVersion = CONFIG_API_VERSION;
  if (isRecord(out.modules)) {
    out.modules = Object.fromEntries(Object.entries(out.modules).map(([id, module]) => [RENAMED_PACKS[id] ?? id, module]));
  }
  if (isRecord(out.curriculum) && Array.isArray(out.curriculum.importedSources)) {
    const importedSources = out.curriculum.importedSources.map((source: unknown) => (typeof source === "string" ? RENAMED_SOURCES[source] ?? source : source));
    out.curriculum = { ...out.curriculum, importedSources };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Named policy defaults a document starts from. Every profile prohibits automated SEL profiling
 * (ADR-0004); they differ in how much AI spend, AI help and teacher visibility they allow. Each sets
 * every setting, including the optional `aiHelp`, so a compiled floor is always complete.
 */
export const DEFAULTS_PROFILES = {
  "us-k12-conservative": {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiHelp: "hints-only",
    aiMonthlyCapCentsPerPrincipal: 200,
  },
  "us-k12-standard": {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-and-shared-conversations",
    automatedSelProfiling: "prohibited",
    aiHelp: "full",
    aiMonthlyCapCentsPerPrincipal: 500,
  },
} as const satisfies Record<string, Required<PolicySettings>>;

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

/** A version range a document may select a pack version with: exact, caret or tilde (see `semver.ts`). */
export const VersionRange = z.string().max(100).refine((range) => parseRange(range) !== undefined, {
  message: "expected an exact, ^ or ~ version range",
});

/**
 * A module entry: the state alone, or the state with pack configuration and, optionally, a version
 * range. Without a range the pack's default version is selected (see `CapabilityRegistry.packs`).
 */
export const ModuleEntry = z.union([
  ModuleState,
  z.strictObject({
    state: ModuleState,
    version: VersionRange.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
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
    /** How much an AI helper may do for a student: `full`, `hints-only` or `none`. */
    help: z.enum(POLICY_ORDERINGS.aiHelp).optional(),
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
  if (policies.ai?.help !== undefined) overrides.aiHelp = policies.ai.help;
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
  importedSources: z.array(z.enum(["district-approved", "educateos-catalog"])).min(1),
});

const Identity = z.strictObject({
  provider: z.enum(["district-sso", "cloudflare-access"]),
  /** ClassLink sign-in, for a district whose SSO is ClassLink. */
  classlink: ClassLinkSso.optional(),
}).superRefine((identity, context) => {
  if (identity.classlink !== undefined && identity.provider !== "district-sso") {
    context.addIssue({ code: "custom", path: ["classlink"], message: "ClassLink sign-in is a district-sso provider" });
  }
});

const Rostering = z.strictObject({
  provider: z.enum(["oneroster-csv", "oneroster-api", "clever", "google-classroom", "manual"]),
  mode: z.enum(["preview-before-apply", "apply-automatically"]),
  /**
   * How the roster's users map to the IdP's subjects, for a OneRoster provider. The issuer must be
   * one the district trusts, which the plan checks against the directory.
   */
  identityMapping: RosterIdentityMapping.optional(),
  /** When the roster syncs, for a OneRoster or Clever provider. */
  schedule: RosterSyncSchedule.optional(),
  /**
   * Which Clever district a Clever roster reads (SCHO-203). Required for, and only for, the
   * `clever` provider. Its district token is a Worker secret, never configuration.
   */
  clever: CleverRosterConnection.optional(),
  /** The ClassLink Roster Server, for a OneRoster API roster that ClassLink serves (SCHO-204). */
  classlink: ClassLinkRosterConnection.optional(),
  /** When a sync that would deactivate much of the roster is held for review. The sync's default when absent. */
  removalHold: RemovalHold.optional(),
}).superRefine((rostering, context) => {
  if (rostering.classlink !== undefined && rostering.provider !== "oneroster-api") {
    context.addIssue({ code: "custom", path: ["classlink"], message: "a ClassLink roster is a oneroster-api provider" });
  }
  if (rostering.provider === "manual") {
    for (const field of ["identityMapping", "schedule", "clever", "removalHold"] as const) {
      if (rostering[field] !== undefined) context.addIssue({ code: "custom", path: [field], message: `a manual roster has no ${field}` });
    }
    return;
  }
  if (rostering.provider === "google-classroom") {
    const mapping = rostering.identityMapping;
    if (mapping?.issuer !== "https://accounts.google.com" || mapping.subject.field !== "username") {
      context.addIssue({ code: "custom", path: ["identityMapping"], message: "a Classroom roster uses the Google issuer and Google user ID as username" });
    }
  }
  if (rostering.provider === "clever") {
    if (rostering.clever === undefined) context.addIssue({ code: "custom", path: ["clever"], message: "a Clever roster names its Clever district" });
    const subject = rostering.identityMapping?.subject;
    // A Clever roster records each user's Clever ID as `userIds` type `clever`, the subject Clever SSO asserts.
    if (subject !== undefined && !(subject.field === "userIds" && subject.type === "clever")) {
      context.addIssue({ code: "custom", path: ["identityMapping", "subject"], message: "a Clever roster's subject is the Clever user ID: userIds of type clever" });
    }
  } else if (rostering.clever !== undefined) {
    context.addIssue({ code: "custom", path: ["clever"], message: "only a Clever roster names a Clever district" });
  }
});

/**
 * The declarative district configuration (roadmap §4.1), parsed from JSON or from YAML converted to
 * JSON by the caller. Unknown fields are rejected. Credentials never belong here; see `secrets.ts`.
 */
export const DistrictConfigDocument = z.preprocess(withCurrentNames, z.strictObject({
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
}));
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
export const DesiredState = z.preprocess(withCurrentNames, z.strictObject({
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
}));
/** A compiled desired state. */
export type DesiredState = z.infer<typeof DesiredState>;
