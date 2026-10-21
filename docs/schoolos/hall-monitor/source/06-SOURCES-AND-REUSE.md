# 06 — Source Register, Verified Code, Assumptions and Gaps

**Verification date:** October 20, 2026. Re-check before implementing pricing/Cloudflare endpoint contracts and before any student rollout. Links listed here are the provenance intended for implementation docs, not an endorsement of a vendor's legal/privacy terms.

## 1. Existing repositories inspected

### `gmackie/playtrek` (private)

- `packages/ai/src/hallMonitor/index.ts` — exports existing validator/evaluator engine, test fixtures, `validateContent`, `generateValidated`, Hall Monitor registry. This is an embedded *content* evaluator, not yet a standalone HTTP service.
- `packages/ai/src/hallMonitor/validate.ts` and `rules.ts` — deterministic text rule validation and review labels. Port generic rule vocabulary only; existing content-specific matched-text evidence must not flow into the cost ledger.
- `packages/ai/src/hallMonitor/evaluators/registry.ts` and `evaluators/types.ts` — named deterministic and AI evaluators; existing evaluator signature depends on `ComposedEpisode`, `EvalPersona`. Introduce product-neutral adapters.
- `packages/db/src/schema/ai.ts` — `aiGenerations` includes provider, model, `usagePromptTokens`, `usageCompletionTokens`, `costUsd`, status, purpose and prompt text fields. Treat usage as a migration source with incomplete cache/financial semantics. Do **not** mirror raw prompts to cost events.
- `packages/edtech/src/case/{client,sync}.ts` — existing standards syncing for curriculum QC; not a Hall Monitor policy enforcement boundary.
- `packages/config/src/ai-providers.ts` — model provider allowlist/settings and launch modes. Extend to emit model usage receipts and versioned routing decisions.
- `packages/lti/src/` — LTI 1.3 components which need independent policy treatment for grade passback and verified identity.

### `gmackie/school-os` (public Cloudflare OS fork)

- `packages/workshop-backend/src/ai-models.ts` — decision-model support, `getDecisionModel`, `DecisionModelGatekeeper`, AI Gateway metadata and provider routing. Clef binding path already exists but is not mandatory ingress moderation.
- `packages/workshop-backend/src/decision-model-binding.d.ts` — `decide(request)` with typed choice/bool/score questions and probabilistic answers.
- `packages/workshop-backend/src/overseer.ts` — `newChat`, `sendChatMessage`, `steerRunningTurn` (important async steering bypass risk), message-preparation and external-agent paths. New mandatory ingress must operate at trusted server.
- `packages/workshop-backend/src/agent-tracing.ts` — usage spans and model request correlation, good for observability but not an immutable finance ledger.
- `docs/ai-gateway-billing.md` — free daily **call** allowance and optional personal Cloudflare credits, not district-ledger financial ceilings. Some direct Clef/Gateway transport restrictions are documented: prefer actual binding and verified configured route.
- `packages/gatekeeper-context/src/artifact-sync.ts` — imports external Git-backed context; useful for content review inputs, not suitable as a general moderation transport.
- `AGENTS.md` — emphasizes small, reviewable changes to Workshop backend/shared RPC contracts. Respect this when integrating server-side guardrails.

**Existence check:** There is no confirmed `gmackie/hall-monitor` repository at the time of research. Its proposed layout and PR identifiers here are a plan, not completed source code.

## 2. Cloudflare official documentation reviewed

| Topic | URL | What to pin |
|---|---|---|
| Clef announcement (2026-10-01) | https://blog.cloudflare.com/clef-decision-models/ | Typed decision model semantics, model availability |
| Clef-omni / flash repricing (2026-10-09) | https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/ | Reason older crawled prices may disagree |
| Workers AI pricing | https://developers.cloudflare.com/workers-ai/platform/pricing/ | $0.038 Clef-flash, $0.240 Clef, $0.150 omni/M; neuron allowance |
| Clef-flash model | https://developers.cloudflare.com/workers-ai/models/clef-flash/ | Context limit, text/image input token price and media billing |
| Clef-omni model | https://developers.cloudflare.com/workers-ai/models/clef-omni/ | Media input pricing/metering |
| AI Gateway pricing | https://developers.cloudflare.com/ai-gateway/reference/pricing/ | Core free, Unified Billing fee, Gateway logs and Guardrails |
| AI Gateway spend limits | https://developers.cloudflare.com/ai-gateway/features/spend-limits/ | Eventually consistent, scoped by model/provider/metadata, 429 response |
| AI Gateway custom metadata | https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/ | Up to 5 custom values, `cf.` reserved, no PII |
| AI Gateway logging | https://developers.cloudflare.com/ai-gateway/observability/logging/ | `cf-aig-collect-log-payload: false`, content-free log availability |
| AI Gateway limits | https://developers.cloudflare.com/ai-gateway/reference/limits/ | Gateway/metadata/limits, Unified Billing RPS |
| Workers AI data usage | https://developers.cloudflare.com/workers-ai/platform/data-usage/ | Provider data-handling commitments, confirm contract |
| Workers pricing | https://developers.cloudflare.com/workers/platform/pricing/ | $5 plan and CPU/requests included |
| DO pricing | https://developers.cloudflare.com/durable-objects/platform/pricing/ | GB-sec active duration, storage and requests |
| D1 pricing | https://developers.cloudflare.com/d1/platform/pricing/ | Row/storage pricing |
| R2 pricing | https://developers.cloudflare.com/r2/pricing/ | Storage and operation billing |
| Artifacts pricing | https://developers.cloudflare.com/artifacts/platform/pricing/ | Oct 14, 2026 charges, ops/storage |
| Dynamic Workers | https://developers.cloudflare.com/dynamic-workers/pricing/ | Unique Worker identity/day and CPU/request |
| Containers pricing | https://developers.cloudflare.com/containers/platform/pricing/ | Isolated CI jobs: CPU, memory, disk, egress |
| AI Search pricing | https://developers.cloudflare.com/ai-search/platform/limits-pricing/ | Model from Nov 1, 2026 announced billing |
| Workers Logs pricing | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | 20M events included Oct 2026; announced Dec 2026 change |

### Prior SchoolOS analysis (local attachments)

- `SchoolOS_AI_Cost_Calculator_2026-10.xlsx` — eight baseline sheets, including `Model Sensitivity!A1:H21`. The selected `A1:H1` range is a presentation title, **not** the source of model price assumptions. Model prices appear in `Model Prices!A4:G13`, while full all-premium cost comparisons appear in `Model Sensitivity!A4:H21`.
- `SchoolOS_AI_Models_Token_Budgets_and_Cloudflare_Deployment_Case_Study_2026-10-20.md` — scenario assumptions, Cloudflare billing details, income/cost profiles.
- `SchoolOS_Build_Scope_and_PR_Roadmap.md` — broader SchoolOS milestone dependencies, AI governance stream.
- `SchoolOS_Master_Architecture_and_Implementation_Plan_v0.4.md` — educator-first district architecture, Learning Registry, Assessment CI, content vetting and federation.

## 3. Facts versus assumptions

**Verified code facts:** PlayTrek Hall Monitor exists as integrated evaluators; PlayTrek `aiGenerations` has usage/cost fields; Cloudflare OS has a typed DecisionModelBinding and Gateway attribution support; no SchoolOS-specific mandatory Hall Monitor service exists in the inspected upstream fork.

**Verified published rates:** Cloudflare list-rate Clef family and platform rates as of October 20, 2026; official price pages linked above. Rates can change and do not automatically represent negotiated discounts, country-specific invoices or media workloads.

**Model assumptions:** 320 teacher calls/month, 78 AI-student calls/month, 1,000 text input tokens/check, input+output screening, 10% selective Clef escalations at 1,500 tokens, 10% generative contingency, illustrative service pool $0.10/AI-enabled user/month with $5 minimum, and model-selection policy. None has been measured from an actual SchoolOS deployment.

**Implementation proposals:** New repo/package structure, APIs, UUID/opaque principal model, financial ledger, per-tenant Budget DO, cross-account signed service identity, product ingress hooks, managed service deployment and specific PR numbers; they do not yet exist.

## 4. Important validation questions before production

1. Confirm product-specific child-data processing basis, parental consents where required, FERPA/COPPA applicability, vendor data retention/DPA and authorized safety response for each homeschool/co-op/district model.
2. Verify how Clef input token counts are surfaced in the chosen Workers AI binding response and whether direct versus Gateway routes generate the required billing IDs. Do not infer a token count from characters without an error envelope.
3. Verify Cloudflare Workers AI daily included neurons and Gateway Unified Billing/credit interactions in a real test account.
4. Confirm Cloudflare Worker service-binding behavior within account and signed HTTPS route across accounts for sovereign deployment.
5. Confirm whether any SchoolOS Workshop auto-generated model/tool calls bypass the proposed intercept points; the extracted ingress coverage test matrix is mandatory.
6. Determine whether PlayTrek requires privacy-mandated restrictions on existing stored `aiGenerations.systemPrompt`, `userPrompt` and responses before exporting usage to a shared ledger.
7. Calibrate moderation thresholds and crisis handling on independently curated synthetic/licensed reference data; typed model probabilities are not clinical/safety guarantees.
8. Check observability pricing again ahead of its scheduled 2026-12-01 change and any new provider contracts.
9. Test Cloudflare monthly account billing allocation in multiple accounts; don't assume per-service logs equal invoices or per-user cost.
