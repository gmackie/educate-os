// Whether this deployment's guard config funds the models the Workshop offers (SCHO-401). The
// Workshop's model pickers list its visible Workers AI suggestions, and the guard refuses any model
// it does not catalog, fund from a non-safety pool, or price. A config edited by hand can drift from
// that list: on Northfield it left out the Workshop's default model, so a new teacher's first message
// was refused. The guard logs any such gap once per config, where an operator sees it.

import { createLogger } from "@gadgets/observability/logger";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import type { GuardConfig } from "./config.ts";
import { rateFor } from "./pricing.ts";

/** What the config lacks for one offered model. */
export type CoverageGap = "catalog" | "pool" | "rate";

/** An offered model the config does not fully fund, and what it lacks. */
export interface UnfundedModel {
  provider: "cloudflare";
  modelId: string;
  missing: CoverageGap[];
}

/**
 * The Workshop's visible Workers AI suggestions that `config` would refuse: not enabled in its
 * catalog, in no pool other than the safety pool, or without a rate.
 */
export function unfundedOfferedModels(config: GuardConfig, at: Date = new Date()): UnfundedModel[] {
  const gaps: UnfundedModel[] = [];
  for (const [modelId, model] of Object.entries(SUGGESTED_MODELS.cloudflare)) {
    if ("hidden" in model && model.hidden) continue;
    const ref = { provider: "cloudflare", modelId } as const;
    const matches = (m: { provider: string; modelId: string }) => m.provider === ref.provider && m.modelId === modelId;
    const missing: CoverageGap[] = [];
    if (!config.modelCatalog.some((m) => matches(m) && m.mode === "enabled")) missing.push("catalog");
    if (!config.fundingPools.some((pool) => pool.purpose !== "safety" && pool.allowedModels.some(matches))) missing.push("pool");
    if (rateFor(config, ref, at) === undefined) missing.push("rate");
    if (missing.length > 0) gaps.push({ ...ref, missing });
  }
  return gaps;
}

const logger = createLogger<{ models: string[] }>({ component: "educateos.ai-guard.config" });
const reported = new WeakSet<GuardConfig>();

/** Logs, once per parsed config, the offered models it does not fund. */
export function reportUnfundedOfferedModels(config: GuardConfig): void {
  if (reported.has(config)) return;
  reported.add(config);
  const gaps = unfundedOfferedModels(config);
  if (gaps.length === 0) return;
  logger.warn("the guard config does not fund models the Workshop offers", {
    event: "ai_guard.config.unfunded_offered_models",
    models: gaps.map((gap) => `${gap.modelId} (${gap.missing.join(", ")})`),
  });
}
