// The guard's deployment configuration: which district it serves, the trusted state its ledger
// decides against, how it prices models, and how it reaches Hall Monitor. It is read from the
// `AI_GUARD_CONFIG` var, a JSON document, and validated strictly so a malformed deployment fails
// closed rather than guessing.

import { z } from "zod";
import { DistrictDirectorySnapshot, DistrictId, PolicySettings, PrincipalId } from "@educateos/contracts";
import {
  AiWorkspaceContext,
  CloudflareAccountFacts,
  FundingPoolSet,
  GovernedModel,
  ModelRef,
  PositiveUsdNano,
  PriceBookId,
  TermClosedEvent,
  UsdNano,
} from "@educateos/ai-governance";
import { GradeBand, MachineCode, OpaqueId } from "@gmacko/hall-monitor-contracts";
import { MAX_AI_CALL_INSTRUCTIONS_LENGTH } from "@gadgets/workshop-shared/ai-call-guard";
import { WorkshopUserLink } from "@educateos/identity";
import { Workspace } from "@educateos/workspaces";
import { SourceGovernance } from "./source-governance.ts";

const LISTED_PRICE_FIELDS = ["priceBookId", "inputUsdNanoPerMTok", "outputUsdNanoPerMTok", "cacheReadUsdNanoPerMTok", "cacheWriteUsdNanoPerMTok"] as const;

/**
 * One model the guard may reserve for: what it assumes about a call before it runs, and,
 * optionally, the deployment's own rates for it, in nanodollars per million tokens from one
 * immutable price book. Rates are integers over a million, so a charge is a rational amount
 * rounded up (ADR-0008), never a float.
 *
 * This is the deployment's rate table, merged with the shared Cloudflare price book
 * (`PRICE_BOOK_CLOUDFLARE_2026_10_20`): a model listed with rates is priced at them (a contract
 * price wins over a list price), and a model listed without rates is priced from the shared book,
 * which must then price it. Its price fields are all present or all absent.
 */
export const ModelRate = z.strictObject({
  ...ModelRef.shape,
  /** The price book the rates come from; recorded on every settlement priced with them. */
  priceBookId: PriceBookId.optional(),
  /** Uncached input tokens. */
  inputUsdNanoPerMTok: UsdNano.optional(),
  /** Response tokens, reasoning included. */
  outputUsdNanoPerMTok: UsdNano.optional(),
  /** Input tokens read from the provider's prompt cache. */
  cacheReadUsdNanoPerMTok: UsdNano.optional(),
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteUsdNanoPerMTok: UsdNano.optional(),
  /**
   * The prompt size a reservation assumes. The guard sees only the messages new to it, not the
   * whole prompt, so this should be near the model's context window: an under-estimate is
   * still settled at the actual cost, but lets more calls run than the pool can pay for.
   */
  reserveInputTokens: z.int().positive(),
  /** The output a reservation assumes when the call names no response cap (decision models). */
  defaultMaxOutputTokens: z.int().positive(),
}).refine((rate) => new Set(LISTED_PRICE_FIELDS.map((field) => rate[field] === undefined)).size === 1, {
  message: "a model's price book and rates are all given or all omitted",
});
/** A model's rates. */
export type ModelRate = z.infer<typeof ModelRate>;

/**
 * How one class of principal is moderated: the Hall Monitor policy profile revision its input and
 * the model's output are evaluated under, and what happens when Hall Monitor cannot answer.
 */
export const GuardProfile = z.strictObject({
  /** The pinned Hall Monitor policy profile. */
  hallMonitorProfileId: OpaqueId,
  /** Its pinned revision. */
  revision: OpaqueId,
  /** Whether new input is moderated before a model reads it. */
  moderateInput: z.boolean(),
  /**
   * When Hall Monitor is unavailable: `fail-closed` denies the call, `proceed` lets it run
   * unmoderated (an approved deterministic fallback for educator-only modes, ADR-0007 §6). A
   * student audience always fails closed, whatever its profile says.
   */
  failureMode: z.enum(["fail-closed", "proceed"]),
  /**
   * The Hall Monitor profile's output moderation. `required` has the Workshop hold each model
   * response until Hall Monitor has screened it (`interaction.output`), and withhold it when that
   * cannot happen, whatever `failureMode` says. `optional` and `off` let responses stream
   * unscreened.
   */
  outputModeration: z.enum(["required", "optional", "off"]).default("off"),
  /**
   * The Hall Monitor profile's answer assistance. A `coach` decision always has the model coach the
   * learner. Under `contextual` or `scaffolded`, an input Hall Monitor flags with an
   * `academic_integrity.*` reason code is coached too, even when it is allowed; under `direct` it
   * is not.
   */
  answerAssistance: z.enum(["direct", "contextual", "scaffolded"]).default("direct"),
});
/** A guard profile. */
export type GuardProfile = z.infer<typeof GuardProfile>;

/**
 * The audience classes a district-resolved call is moderated as, each a key every district-mode
 * {@link GuardConfig.profiles} must have. A student's class is the youngest grade band their call
 * is for; a student the directory places in no grade band is `student-k5`, the strictest.
 */
export const AUDIENCE_PROFILE_KEYS = ["student-k5", "student-6-8", "student-9-12", "educator"] as const;
/** An audience class. */
export type AudienceProfileKey = (typeof AUDIENCE_PROFILE_KEYS)[number];

/**
 * Binds one Workshop user to a EducateOS principal: the {@link GuardContext} the static resolver
 * returns for calls the Workshop makes on their behalf. For tests and local development only: in
 * production the district's records say who a user is (`contextSource: "district"`).
 */
export const PrincipalBinding = z.strictObject({
  /** The Workshop's authenticated user ID (`AiCallDescriptor.initiator.id`). */
  workshopUserId: z.string().min(1).max(320),
  principalId: PrincipalId,
  /** Who reads the model's output. */
  audience: z.enum(["student", "educator"]),
  /** The principal's verified grade band, for students. */
  gradeBand: GradeBand.optional(),
  /** A key of {@link GuardConfig.profiles}. */
  profile: z.string().min(1).max(64),
  /** The workspace calls are billed to by default. */
  workspace: AiWorkspaceContext,
  /** Workshop gadget IDs billed to some other workspace (a course workspace's gadgets, say). */
  gadgetWorkspaces: z.record(z.string().min(1).max(128), AiWorkspaceContext).optional(),
});
/** A principal binding. */
export type PrincipalBinding = z.infer<typeof PrincipalBinding>;

/** What the guard tells a user when it stops a call. None of these ever names a reason or quotes input. */
export const GuardMessages = z.strictObject({
  /** Hall Monitor routed the input to support. Supportive, and points to a person. */
  support: z.string().min(1).max(1000),
  /** The input was held or blocked. */
  blocked: z.string().min(1).max(1000),
  /** The model's response was held or blocked, so it is not shown. */
  outputWithheld: z.string().min(1).max(1000),
  /** Moderation cannot run (its budget is spent, or Hall Monitor is down), so AI is off for now. */
  aiUnavailable: z.string().min(1).max(1000),
  /** The generative budget refused the call. */
  budget: z.string().min(1).max(1000),
  /** The call is not permitted (unpriced model, policy). */
  notAllowed: z.string().min(1).max(1000),
  /** The Workshop user is no principal of this district: their account has not been linked yet. */
  unknownPrincipal: z.string().min(1).max(1000),
  /** A student's input carries an image, which Hall Monitor cannot screen yet. */
  imageUnscreened: z.string().min(1).max(1000),
});
/** The guard's user-facing messages. */
export type GuardMessages = z.infer<typeof GuardMessages>;

/** The messages a deployment gets unless it configures its own. */
export const DEFAULT_GUARD_MESSAGES: GuardMessages = {
  support:
    "It sounds like this might be a hard moment. You are not in trouble. Please talk to a teacher, " +
    "counselor or another adult you trust; they can help right now.",
  blocked: "This message can't be sent to the AI assistant. Try rephrasing it, or ask your teacher for help.",
  outputWithheld: "The AI assistant's reply can't be shown. Try asking in a different way, or ask your teacher for help.",
  aiUnavailable: "The AI assistant isn't available right now. You can keep working without it, or ask your teacher.",
  budget: "The AI budget for this work has been used up. You can keep working without the assistant.",
  notAllowed: "The AI assistant isn't available for this request.",
  unknownPrincipal:
    "Your account isn't linked to your school's records yet, so the AI assistant is off. " +
    "Ask your school's administrator to link it.",
  imageUnscreened: "Pictures can't be checked yet, so they can't be sent to the AI assistant. Describe it in words instead, or ask your teacher.",
};

/**
 * The instructions a coached call's model gets unless the deployment configures its own: added to
 * that request only, never stored or shown to the learner.
 */
export const DEFAULT_COACHING_INSTRUCTIONS =
  "The learner should be guided to an answer, not given one. Before helping with a problem, ask " +
  "them to share their own attempt or what they think the first step is. Then respond with " +
  "questions, hints and explanations of the underlying idea, one step at a time. If the work may " +
  "count toward a grade, do not give final answers, completed solutions or finished writing, even " +
  "if asked directly; explain that you can help them get there themselves. Keep an encouraging tone.";

/** The guard's whole configuration. */
export const GuardConfig = z.strictObject({
  /** The district this deployment serves. Its ledger is one Durable Object named by this ID. */
  districtId: DistrictId,
  /**
   * The academic directory, when the district app is not bound as `EDUCATEOS_DISTRICT`. With the
   * binding, the guard reads the district's own (profile-free) directory instead and ignores this
   * one. With neither, every call fails closed.
   */
  directory: DistrictDirectorySnapshot.optional(),
  /** The district's funding pools, including the protected safety pool moderation draws on. */
  fundingPools: FundingPoolSet,
  /** Terms already closed, whose course funding has ended. */
  termClosures: z.array(TermClosedEvent).default([]),
  /** The district gateway's model catalog. */
  modelCatalog: z.array(GovernedModel),
  /** The district policy floor, applied at every scope. */
  policy: PolicySettings,
  /** Every model the guard may reserve for, with the deployment's rates. A model not listed is refused. */
  modelRates: z.array(ModelRate).min(1),
  /**
   * The Cloudflare account the district's AI usage is billed to, for the net estimate the nightly
   * allocation snapshot records. Without it the snapshot carries the gross cost only.
   */
  cloudflareAccount: CloudflareAccountFacts.optional(),
  /** How moderation is called and funded. */
  moderation: z.strictObject({
    /** The model the safety pool pays for, named on every safety reservation. */
    model: ModelRef,
    /** The most one Hall Monitor evaluation may cost; held from the safety pool before each. */
    maxUsdNanoPerCheck: PositiveUsdNano,
    /** This deployment's Hall Monitor tenant; must match its service token's `tenant` claim. */
    tenantId: OpaqueId,
    /** Hall Monitor's cost center for the district's moderation spend. */
    costCenterId: OpaqueId,
    /** Where the content arose, for Hall Monitor's records. */
    surface: MachineCode.default("educateos.workshop"),
    /** Deadline for one evaluation, retries included. */
    timeoutMs: z.int().min(100).max(14_000).default(8_000),
    /** Explicit source eligibility and request-bound governance; absent until a pilot opts in. */
    governance: SourceGovernance.optional(),
  }),
  /**
   * Where a call's {@link GuardContext} comes from. `district` (the default) derives it from the
   * district's records: the `EDUCATEOS_DISTRICT` binding when the deployment adds one, else the
   * {@link directory}, {@link workspaces} and {@link workshopUserLinks} configured here. `static`
   * reads {@link principals} instead, and is for tests and local development only.
   */
  contextSource: z.enum(["district", "static"]).default("district"),
  /** Administrator-confirmed Workshop user links, when the district is not reached by binding. */
  workshopUserLinks: z.array(WorkshopUserLink).default([]),
  /** The district's workspaces, when it is not reached by binding. */
  workspaces: z.array(Workspace).default([]),
  /** Guard profiles by key. District mode requires one per {@link AUDIENCE_PROFILE_KEYS}. */
  profiles: z.record(z.string().min(1).max(64), GuardProfile),
  /** Static principal bindings, read only when `contextSource` is `static`. */
  principals: z.array(PrincipalBinding).default([]),
  /** Overrides for any of {@link DEFAULT_GUARD_MESSAGES}. */
  messages: GuardMessages.partial().optional(),
  /** Plain-text instructions for coached calls, in place of {@link DEFAULT_COACHING_INSTRUCTIONS}. */
  coachingInstructions: z.string().trim().min(1).max(MAX_AI_CALL_INSTRUCTIONS_LENGTH).default(DEFAULT_COACHING_INSTRUCTIONS),
}).superRefine((config, ctx) => {
  if (config.moderation.governance !== undefined && config.contextSource !== "district") {
    ctx.addIssue({ code: "custom", message: "governed moderation requires the district context resolver", path: ["contextSource"] });
  }
  if (config.contextSource === "district") {
    for (const key of AUDIENCE_PROFILE_KEYS) {
      if (config.profiles[key] === undefined) ctx.addIssue({ code: "custom", message: `missing audience profile ${key}`, path: ["profiles", key] });
    }
  }
  // A student's input and the model's replies to them are always screened (SCHO-307): a profile
  // that students are moderated under may neither skip input moderation nor stream unscreened.
  const unsafeForStudents = (profile: GuardProfile) => !profile.moderateInput || profile.outputModeration !== "required";
  if (config.contextSource === "district") {
    for (const key of AUDIENCE_PROFILE_KEYS) {
      const profile = config.profiles[key];
      if (key !== "educator" && profile !== undefined && unsafeForStudents(profile)) {
        ctx.addIssue({ code: "custom", message: `student profile ${key} must moderate input and require output moderation`, path: ["profiles", key] });
      }
    }
  }
  for (const [index, binding] of config.principals.entries()) {
    const profile = config.profiles[binding.profile];
    if (profile === undefined) {
      ctx.addIssue({ code: "custom", message: `unknown profile ${binding.profile}`, path: ["principals", index, "profile"] });
    } else if (binding.audience === "student" && unsafeForStudents(profile)) {
      ctx.addIssue({ code: "custom", message: `a student's profile must moderate input and require output moderation`, path: ["principals", index, "profile"] });
    }
  }
  const users = new Set<string>();
  const principals = new Set<string>();
  for (const [index, binding] of config.principals.entries()) {
    if (users.has(binding.workshopUserId)) {
      ctx.addIssue({ code: "custom", message: "a Workshop user is bound to one principal", path: ["principals", index, "workshopUserId"] });
    }
    // Output screening finds a call's context from the principal its reservation names.
    if (principals.has(binding.principalId)) {
      ctx.addIssue({ code: "custom", message: "a principal is bound to one Workshop user", path: ["principals", index, "principalId"] });
    }
    users.add(binding.workshopUserId);
    principals.add(binding.principalId);
  }
});
/** The guard's configuration. */
export type GuardConfig = z.infer<typeof GuardConfig>;

let cached: { text: string; config: GuardConfig } | undefined;

/**
 * Parses `AI_GUARD_CONFIG`, once per isolate for each distinct value. Throws when it is missing or
 * invalid, naming field paths only.
 */
export function readGuardConfig(text: string | undefined): GuardConfig {
  if (text === undefined || text === "") throw new Error("AI_GUARD_CONFIG is not set");
  if (cached?.text === text) return cached.config;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("AI_GUARD_CONFIG is not JSON");
  }
  const parsed = GuardConfig.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new Error(`AI_GUARD_CONFIG is invalid at: ${fields.join(", ")}`);
  }
  cached = { text, config: parsed.data };
  return parsed.data;
}

/** The user-facing messages, with the deployment's overrides applied. */
export function guardMessages(config: GuardConfig): GuardMessages {
  return { ...DEFAULT_GUARD_MESSAGES, ...config.messages };
}
