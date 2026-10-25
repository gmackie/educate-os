import type { PolicySettings } from "@educateos/contracts";
import { sameModel, type AiDenialReason, type AiProvider, type GovernedModel, type ModelRef } from "./model.ts";
import type { FundingPool } from "./pools.ts";

/** What model routing reads: the effective policy, the gateway catalog and the candidate pools. */
export interface ModelPolicyInput {
  /** The effective policy at the request's scope. */
  policy: PolicySettings;
  /** The district gateway's models and their modes. */
  catalog: readonly GovernedModel[];
  /** The pools that may fund the request, narrowest first (see `resolveFunding`). */
  pools: readonly FundingPool[];
}

/** The routed model and the pools that will pay for it, or why the request is refused. */
export type ModelRoute =
  | { ok: true; model: GovernedModel; pools: FundingPool[] }
  | { ok: false; reason: AiDenialReason };

/**
 * Routes a request to a model, or refuses it, before any money is held. Pure: the same request and
 * policy always give the same answer.
 *
 * The requested model is the only candidate; nothing is silently swapped for a different one. It
 * is refused when the policy disables AI spending, when the gateway does not list it or has it
 * `disabled`, or when no candidate pool allows it. The pools returned are the candidates that
 * allow it, in the order they will be drawn on.
 */
export function routeModel(requested: ModelRef, input: ModelPolicyInput): ModelRoute {
  if (input.policy.aiSpending === "disabled") return { ok: false, reason: "ai-spending-disabled" };
  const model = input.catalog.find((entry) => sameModel(entry, requested));
  if (model === undefined) return { ok: false, reason: "model-unknown" };
  if (model.mode === "disabled") return { ok: false, reason: "model-disabled" };
  const pools = input.pools.filter((pool) => pool.allowedModels.some((allowed) => sameModel(allowed, model)));
  if (pools.length === 0) return { ok: false, reason: "model-not-allowed" };
  return { ok: true, model, pools };
}

/** The models and providers a request in some context may use. */
export interface AllowedModels {
  /** The runnable models, in catalog order. */
  models: GovernedModel[];
  /** Their providers, in first-seen order. */
  providers: AiProvider[];
}

/**
 * The models a request could be routed to: those the gateway runs that at least one candidate pool
 * pays for, or none when the policy disables AI spending. This is what a model picker should offer.
 */
export function allowedModels(input: ModelPolicyInput): AllowedModels {
  const models = input.policy.aiSpending === "disabled"
    ? []
    : input.catalog.filter((model) =>
      model.mode !== "disabled"
      && input.pools.some((pool) => pool.allowedModels.some((allowed) => sameModel(allowed, model))));
  return { models, providers: [...new Set(models.map((model) => model.provider))] };
}
