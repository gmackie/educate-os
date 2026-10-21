// The guard's deployment configuration: which district it serves, the trusted state its ledger
// decides against, how it prices models, and how it reaches Hall Monitor. It is read from the
// `AI_GUARD_CONFIG` var, a JSON document, and validated strictly so a malformed deployment fails
// closed rather than guessing.

import { z } from "zod";
import { DistrictDirectorySnapshot, DistrictId, PolicySettings, PrincipalId } from "@schoolos/contracts";
import {
  AiWorkspaceContext,
  FundingPoolSet,
  GovernedModel,
  ModelRef,
  PositiveUsdNano,
  PriceBookId,
  TermClosedEvent,
  UsdNano,
} from "@schoolos/ai-governance";
import { GradeBand, MachineCode, OpaqueId } from "@gmacko/hall-monitor-contracts";

/**
 * One model's list rates, in nanodollars per million tokens, from one immutable price book, plus
 * what the guard assumes about a call before it runs. Rates are integers over a million, so a
 * charge is a rational amount rounded up (ADR-0008), never a float.
 */
export const ModelRate = z.strictObject({
  ...ModelRef.shape,
  /** The price book the rates come from; recorded on every settlement priced with them. */
  priceBookId: PriceBookId,
  /** Uncached input tokens. */
  inputUsdNanoPerMTok: UsdNano,
  /** Response tokens, reasoning included. */
  outputUsdNanoPerMTok: UsdNano,
  /** Input tokens read from the provider's prompt cache. */
  cacheReadUsdNanoPerMTok: UsdNano,
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteUsdNanoPerMTok: UsdNano,
  /**
   * The prompt size a reservation assumes. The guard sees only the messages new to it, not the
   * whole prompt, so this should be near the model's context window: an under-estimate is
   * still settled at the actual cost, but lets more calls run than the pool can pay for.
   */
  reserveInputTokens: z.int().positive(),
  /** The output a reservation assumes when the call names no response cap (decision models). */
  defaultMaxOutputTokens: z.int().positive(),
});
/** A model's rates. */
export type ModelRate = z.infer<typeof ModelRate>;

/**
 * How one class of principal is moderated: the Hall Monitor policy profile revision its input is
 * evaluated under, and what happens when Hall Monitor cannot answer.
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
});
/** A guard profile. */
export type GuardProfile = z.infer<typeof GuardProfile>;

/**
 * Binds one Workshop user to a SchoolOS principal: the {@link GuardContext} the static resolver
 * returns for calls the Workshop makes on their behalf.
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
  /** Moderation cannot run (its budget is spent, or Hall Monitor is down), so AI is off for now. */
  aiUnavailable: z.string().min(1).max(1000),
  /** The generative budget refused the call. */
  budget: z.string().min(1).max(1000),
  /** The call is not permitted (unknown user, unpriced model, policy). */
  notAllowed: z.string().min(1).max(1000),
});
/** The guard's user-facing messages. */
export type GuardMessages = z.infer<typeof GuardMessages>;

/** The messages a deployment gets unless it configures its own. */
export const DEFAULT_GUARD_MESSAGES: GuardMessages = {
  support:
    "It sounds like this might be a hard moment. You are not in trouble. Please talk to a teacher, " +
    "counselor or another adult you trust; they can help right now.",
  blocked: "This message can't be sent to the AI assistant. Try rephrasing it, or ask your teacher for help.",
  aiUnavailable: "The AI assistant isn't available right now. You can keep working without it, or ask your teacher.",
  budget: "The AI budget for this work has been used up. You can keep working without the assistant.",
  notAllowed: "The AI assistant isn't available for this request.",
};

/** The guard's whole configuration. */
export const GuardConfig = z.strictObject({
  /** The district this deployment serves. Its ledger is one Durable Object named by this ID. */
  districtId: DistrictId,
  /** The academic directory funding is resolved against. */
  directory: DistrictDirectorySnapshot,
  /** The district's funding pools, including the protected safety pool moderation draws on. */
  fundingPools: FundingPoolSet,
  /** Terms already closed, whose course funding has ended. */
  termClosures: z.array(TermClosedEvent).default([]),
  /** The district gateway's model catalog. */
  modelCatalog: z.array(GovernedModel),
  /** The district policy floor, applied at every scope. */
  policy: PolicySettings,
  /** Rates for every model the guard may reserve for. A model with none is refused. */
  modelRates: z.array(ModelRate).min(1),
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
    surface: MachineCode.default("schoolos.workshop"),
    /** Deadline for one evaluation, retries included. */
    timeoutMs: z.int().min(100).max(14_000).default(8_000),
  }),
  /** Guard profiles by key. */
  profiles: z.record(z.string().min(1).max(64), GuardProfile),
  /** The principals this deployment serves. */
  principals: z.array(PrincipalBinding),
  /** Overrides for any of {@link DEFAULT_GUARD_MESSAGES}. */
  messages: GuardMessages.partial().optional(),
}).superRefine((config, ctx) => {
  for (const [index, binding] of config.principals.entries()) {
    if (config.profiles[binding.profile] === undefined) {
      ctx.addIssue({ code: "custom", message: `unknown profile ${binding.profile}`, path: ["principals", index, "profile"] });
    }
  }
  const users = new Set<string>();
  for (const [index, binding] of config.principals.entries()) {
    if (users.has(binding.workshopUserId)) {
      ctx.addIssue({ code: "custom", message: "a Workshop user is bound to one principal", path: ["principals", index, "workshopUserId"] });
    }
    users.add(binding.workshopUserId);
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
