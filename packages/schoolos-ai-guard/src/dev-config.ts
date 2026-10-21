// The guard configuration `pnpm dev-server --with-ai-guard` and PR previews run with when no
// `AI_GUARD_CONFIG` is supplied. Never part of a release: only dev-worker.ts imports it.
//
// It is built in code rather than shipped as a var because a directory snapshot plus a rate for
// every suggested model is over Cloudflare's var size limit. Everything in it is synthetic: the
// Northfield fixture district (a dev dependency, bundled only into the dev entrypoint), and a flat
// dev price book, so holds and settlements behave like production without matching any provider's
// bill.

import { SUGGESTED_MODELS, type AiModelProvider } from "@gadgets/workshop-shared/api";
import { NORTHFIELD } from "@schoolos/fixtures";
import type { z } from "zod";
import type { GuardConfig } from "./config.ts";

/**
 * The Workshop user ID of the dev config's catch-all principal binding. Dev and preview user IDs
 * are Durable Object IDs nobody can know in advance, so the dev entrypoint resolves an unbound
 * user to this binding (`DevGuardContextResolver`); the production resolver never does.
 */
export const DEV_ANY_USER = "*";

/** The model the dev safety pool pays the fake Hall Monitor's checks to. */
export const DEV_MODERATOR = { provider: "cloudflare", modelId: "dev-fake-hall-monitor" } as const;

const PERSONAL = { kind: "personal" } as const;

/** Every suggested model, which is every model a dev or preview Workshop offers out of the box. */
const SUGGESTED = (Object.entries(SUGGESTED_MODELS) as [AiModelProvider, Record<string, { contextWindow?: number }>][])
  .flatMap(([provider, models]) => Object.entries(models).map(([modelId, model]) => ({ provider, modelId, contextWindow: model.contextWindow })));

/** The dev configuration, as JSON-ready data. */
export const DEV_GUARD_CONFIG = {
  districtId: "dst_northfield",
  directory: NORTHFIELD,
  fundingPools: [
    {
      id: "fpl_dev-personal",
      name: "Personal workspaces (dev)",
      purpose: "personal",
      scope: { level: "district", districtId: "dst_northfield" },
      // $1,000 a month: generous enough that a developer never runs out by accident.
      monthlyAllocationUsdNano: "1000000000000",
      allowedModels: SUGGESTED.map(({ provider, modelId }) => ({ provider, modelId })),
    },
    {
      id: "fpl_dev-safety",
      name: "Moderation (dev)",
      purpose: "safety",
      scope: { level: "district", districtId: "dst_northfield" },
      monthlyAllocationUsdNano: "100000000000",
      allowedModels: [DEV_MODERATOR],
    },
  ],
  modelCatalog: [
    ...SUGGESTED.map(({ provider, modelId }) => ({ provider, modelId, mode: "enabled" as const })),
    { ...DEV_MODERATOR, mode: "hidden" as const },
  ],
  policy: {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 100_000,
  },
  modelRates: SUGGESTED.map(({ provider, modelId, contextWindow }) => ({
    provider,
    modelId,
    priceBookId: "dev-flat-rate",
    // $0.10 in and $0.40 out per million tokens, whatever the model.
    inputUsdNanoPerMTok: "100000000",
    outputUsdNanoPerMTok: "400000000",
    cacheReadUsdNanoPerMTok: "10000000",
    cacheWriteUsdNanoPerMTok: "125000000",
    reserveInputTokens: Math.min(contextWindow ?? 128_000, 128_000),
    defaultMaxOutputTokens: 4096,
  })),
  moderation: {
    model: DEV_MODERATOR,
    maxUsdNanoPerCheck: "100000",
    tenantId: "tenant_dev",
    costCenterId: "cc_dev",
    timeoutMs: 2000,
  },
  profiles: {
    student: { hallMonitorProfileId: "k12-student", revision: "dev", moderateInput: true, failureMode: "fail-closed" },
  },
  principals: [
    // Every dev user is a moderated student, the audience the guard is strictest for.
    { workshopUserId: DEV_ANY_USER, principalId: "prn_nf-student-dmitri", audience: "student", gradeBand: "9-12", profile: "student", workspace: PERSONAL },
  ],
} satisfies z.input<typeof GuardConfig>;
