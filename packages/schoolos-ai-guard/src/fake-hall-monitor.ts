// A fake Hall Monitor for tests, `pnpm dev-server --with-ai-guard` and PR previews. Never bound in
// a release: production reaches the real Hall Monitor (hall-monitor.ts).
//
// It speaks Hall Monitor's real HTTP API with real wire shapes: it validates each request against
// `EvaluationRequest` and answers with an `EvaluationResult` carrying a cost receipt. It allows
// everything unless the evaluated text carries a marker: `[[block]]`, `[[hold]]`, `[[support]]` or
// `[[coach]]` picks that decision, `[[integrity]]` adds an academic-integrity reason code to it,
// `[[unpriced]]` reports an attempt with no price, and `[[down]]` fails as an unavailable service.

import { EvaluationRequest, EvaluationResult, type Decision } from "@gmacko/hall-monitor-contracts";

/** What one fake evaluation costs: $0.000038. */
export const FAKE_CHECK_COST_USD_NANO = "38000";

const DECISIONS: readonly Decision[] = ["block", "hold", "support", "coach"];

/** Answers one Hall Monitor API request as the fake does. */
export async function fakeHallMonitor(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/evaluations") {
    return Response.json({ code: "invalid_request", message: "not found", retryable: false }, { status: 404 });
  }
  const parsed = EvaluationRequest.safeParse(await request.json());
  if (!parsed.success) return Response.json({ code: "invalid_request", message: "invalid request", retryable: false }, { status: 400 });
  const evaluation = parsed.data;
  const text = evaluation.content.type === "text" ? evaluation.content.text : "";
  if (text.includes("[[down]]")) {
    return Response.json({ code: "unavailable", message: "classifier backend unavailable", retryable: true }, { status: 503 });
  }
  const decision = DECISIONS.find((candidate) => text.includes(`[[${candidate}]]`)) ?? "allow";
  const unpriced = text.includes("[[unpriced]]");
  const result: EvaluationResult = {
    schemaVersion: "1.0",
    evaluationId: `ev-${evaluation.requestId}`,
    requestId: evaluation.requestId,
    decision,
    reasonCodes: [
      ...(decision === "allow" ? [] : [`moderation.${decision}`]),
      ...(text.includes("[[integrity]]") ? ["academic_integrity.direct_answer_request"] : []),
    ],
    findings: [],
    uncertain: false,
    policyRevision: evaluation.policy.revision,
    evaluatorBundleRevision: "bundle-1",
    resolverVersion: "resolver-1",
    receipt: {
      receiptId: `rcpt-${evaluation.requestId}`,
      tenantId: evaluation.source.tenantId,
      product: "schoolos",
      costCenterId: evaluation.context.costCenterId,
      logicalRequestId: evaluation.requestId,
      createdAt: new Date().toISOString(),
      purpose: "moderation.input",
      attempts: [{
        attemptId: `att-${evaluation.requestId}`,
        attemptIndex: 0,
        providerId: "workers-ai",
        modelId: "@cf/clef-flash",
        sku: "clef-flash-input",
        priceBookId: "hm-prices-2026-10-20",
        units: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 1 },
        ...(unpriced ? {} : { grossUsdNano: FAKE_CHECK_COST_USD_NANO }),
        state: unpriced ? "unknown" : "provider_reported",
        gatewayLogId: "gw-log-1",
      }],
      totalGrossUsdNano: unpriced ? "0" : FAKE_CHECK_COST_USD_NANO,
      hasUnknownCost: unpriced,
    },
  };
  return Response.json(EvaluationResult.parse(result));
}
