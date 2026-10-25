# 02 — Cross-Product Cost Ledger, Model Metering and Budget Enforcement

**Product-independent requirement:** Every billable AI/tool/Cloudflare action must resolve to a billing owner, purpose, resource scope and price book. The cost system must work for both PlayTrek and EducateOS and for an independently deployed Hall Monitor.

## 1. Financial vocabulary (do not mix these)

| Quantity | Definition | Use |
|---|---|---|
| `usage_quantity` | Raw counter such as input tokens, cached tokens, Workers AI Neurons, container vCPU-sec, Artifact operations | Immutable technical evidence |
| `gross_usage_cost` | Usage × immutable published/list or contracted unit rate **before** credits, included use and volume discounts | Customer/product unit economics; program spend attribution |
| `estimated_billable_cost` | Best model of what vendor will invoice given allowances and provider contract | Forecast / accrual; still an estimate |
| `invoiced_cost` | Actual line item from Cloudflare/provider invoice; backed by invoice id, period, currency | Financial system of record for cash outflow |
| `allocated_cost` | Explicit internal chargeback method distributing invoice and shared platform costs to tenants/cost centers | Managed co-op invoicing and course economics |
| `budget_limit` | Maximum expenditure permitted within a period per policy | Authorization/financial control |
| `reserved_amount` | Maximum or estimated capacity held for a pending operation | Concurrency-safe admission control |
| `settled_amount` | Amount applied after provider result/invoice policy, with uncertainty state | Current available budget |
| `credit/grant/subsidy` | Funding source or billing adjustment, separate from usage | Should not make utilization disappear |

**Rule:** A $0 invoice due to included Workers AI Neurons does **not** mean the workload had zero inference utilization or economic value. Conversely, gross usage priced at list rates does not mean a customer owes that amount on an actual Cloudflare invoice.

Compute in UTC for billing periods but preserve each organization's instructional/term timezone for UX. Historical line items keep the `priceBookId` used at time of reservation and settlement, never retroactively reprice without an explicit adjustment event.

## 2. Cost taxonomy

Every usage event has both `product` and `purpose`:

| Cost family | Subcategory examples | Meter source | Typical funding pool |
|---|---|---|---|
| Generative model inference | teacher chat, lesson authoring, student guided tutoring, Gadget builder, PlayTrek story/episode generation | Provider usage response + AI Gateway/provider logs | Teacher/student/course authoring |
| Hall Monitor | input Clef-flash, output Clef-flash, Clef escalation, omni/media checks, content validation, retries | Hall Monitor usage receipts + Workers AI / Gateway metrics | Mandatory safety, curriculum QA, Assessment QA |
| Assessment CI | rubric LLM calls, grading model, container runtime, regrade/retries | Evaluator runner, provider and Containers metrics | Department / classroom / assessment pool |
| Search/indexing | embeddings, AI Search ingest, semantic queries, reindex on changed content | Provider/AI Search telemetry | Content Studio or shared content library |
| Media | transcription, synthesis, image/video inference | Provider-specific units (seconds, tokens, images) | Explicit activity-specific allowance |
| Cloudflare application infra | Workers CPU/requests, DO req and GB-sec, D1 rows/storage, R2 ops/storage, Artifacts, Dynamic Workers, Queue, Workflow, logs | Cloudflare account metrics/invoices | Shared org overhead, or measurable workload chargeback |
| External SaaS / licensing | Auth/Access seats, publisher tool fees, OneRoster partner, payment processing | Contract/invoice | EducateOS management/tenant overhead |

**Ingress events vs model calls:** A single user message may start multiple model calls, including tool calls, retries, summarization and moderation. User prompts, moderation evaluations, attempts and Cloudflare requests need separate counters and correlations; never assign one flat unit cost per displayed chat bubble.

## 3. Attribution dimensions

Minimum strongly typed dimensions on the authoritative ledger:

- `billingOwnerId`, `tenantId`, `dataPlaneInstanceId`, `product` (`educateos|playtrek|hall-monitor|other`), `serviceId`.
- `principalKey` = opaque tenant-scoped identifier when applicable; `principalRole` = admin/teacher/student/service (authorization must be independently verified).
- `costCenterId` = school/program/course/activity/assessment shared pool; keep link tables separately to avoid storing detailed educational context in provider metadata.
- `activityId`, `workspaceId` = *internal* opaque IDs; not necessarily sent to provider. `requestId`, `evaluationId`, `traceId`, `parentRequestId`, `attemptIndex`.
- `purpose` and `modelProvider`,`modelId`,`billableSku`, `priceBookId`, `fundingPoolId`, timestamps and status.

Use `parentRequestId` to connect a higher-level work item (e.g., generating a Biology unit) to 13 distinct inference calls and three moderation checks. Cost per learning activity sums **all** descendants exactly once.

**AI Gateway five-metadata-entry limit:** Keep an intentional mapping like `tenant`, `product`, `principal`, `request`, `purpose` (all opaque). When Access adds `cf.user_id`, a metadata entry may be displaced; Gateway metadata is an extra reconciliation join aid, not the authoritative data model. Never put student names, grade records, prompts, raw emails or sensitive labels into metadata.

## 4. Usage event contract

An event is immutable, content-free and idempotent. Representative conceptual type:

```ts
type UsageUnit =
  | "input_tokens" | "cached_input_tokens" | "output_tokens"
  | "workers_ai_neurons" | "moderation_evaluations"
  | "worker_requests" | "worker_cpu_ms" | "do_gb_seconds"
  | "container_vcpu_seconds" | "container_gib_seconds"
  | "artifacts_operations" | "artifacts_gb_months"
  | "r2_gb_months" | "search_queries" | "media_seconds";

type CostState = "estimated" | "provider_reported" | "vendor_reconciled" | "adjusted";

type UsageEvent = {
  eventId: string;            // unique logical event
  idempotencyKey: string;     // tenant:request:attempt:meter:type
  measuredAt: string;         // UTC
  ingestedAt: string;
  source: "caller" | "hall_monitor" | "provider" | "cloudflare_invoice";
  tenantId: string;
  product: "schoolos" | "playtrek" | "hall-monitor";
  billingOwnerId: string;
  costCenterId: string;
  requestId: string;
  parentRequestId?: string;
  attempt: number;
  principalKey?: string;      // opaque, district local
  modelId?: string;
  providerId?: string;
  sku: string;
  priceBookId: string;
  units: Array<{ unit: UsageUnit; quantity: string }>;
  grossUsdNano: string;       // use 64-bit integer or decimal
  estimatedNetUsdNano?: string;
  state: CostState;
  receiptDigest: string;      // hash of canonical signed receipt
};
```

Don't persist the whole `UsageEvent` as a duplicated copy in every service. **The bill owner's ledger is the source of truth**; products hold only request IDs and minimal reporting cache. Hall Monitor emits a usage receipt to the caller plus an authenticated batch event path. If it bills a different Cloudflare account than the caller, its own provider usage ledger and the customer's allocated chargeback remain distinguishable.

## 5. Price book and deterministic calculations

Maintain versioned price books with `provider`, `model`, `sku`, `unit`, `priceNumerator`, `priceDenominator`, `currency`, `effectiveFrom`, optional `effectiveTo`, `sourceUrl`, `reviewedAt`, and `contractTier`. Rates may vary by context length, region, cache class, media unit, usage tier, and billing mode. Historical rates are immutable; a new rate has a new revision.

For a text model, if rates are USD per million tokens:

```text
uncached_input = max(0, prompt_tokens - cached_input_tokens)
model_cost = (uncached_input * input_usd_per_m
            + cached_input_tokens * cached_input_usd_per_m
            + output_tokens * output_usd_per_m) / 1_000_000
           + provider_specific_extras
```

**Avoid double counting cache tokens:** Different providers report `prompt_tokens`, `input_tokens`, `cache_read`, `cache_write`, `reasoning_output` differently. The provider adapter must normalize each field and document whether totals include cache. Never sum an inclusive total and its cache subset. If usage is missing, record `unknown`, reserve conservatively, and reconcile later: missing tokens are **not** free.

For Clef-flash (input-only) at $0.038/M input tokens:

```text
1,000 input tokens * $0.038 / 1,000,000 = $0.000038
= 38,000 nanodollars; output classification has no output token charge
```

Use integer amounts (`USD nano` = 10^-9 USD) or decimal arithmetic; do not use IEEE floating-point to debit financial budgets. For Cloudflare Workers AI, also track the underlying *neurons* and the account-wide **10,000-Neuron daily inclusion** separately. Assign a documented allocation methodology to included use; for example, first allocate inclusion at account/day for actual billing, then distribute net vendor spend proportionately across tenant/gross neuron usage (not as a safety policy bypass).

## 6. Budget hierarchy and atomicity

The authoritative budget tree is configurable:

```text
Billing owner (organization, district or managed tenant)
  ├─ Instructional AI allocation
  │    ├─ Curriculum authoring → teacher
  │    ├─ Student opt-in → student → activity / model class
  │    └─ Department / course discretionary spend
  ├─ Shared Assessment CI allocation
  ├─ Mandatory Hall Monitor safety allocation  ← cannot be exhausted by chat wallets
  ├─ Content vetting / quality allocation
  └─ Shared infra allocation
```

For initial deployments, choose **one authoritative Budget DO per billing tenant** backed by transactional SQLite storage. It checks all applicable ancestor caps, performs reserve/settle in one serializable transaction, and stores an idempotency key. This avoids races across independently updated per-student D1 counters. For a large district, partition by deliberately *escrowed* funding grants (preallocated into course/department ledgers) so concurrent children cannot overspend a global cap; reconcile escrows periodically. Never claim cross-DO transfers are atomic unless proven by a protocol.

### Reservation → usage → settlement

1. Authenticated caller resolves principal, product, course/funding and allowed model tier.
2. Estimate a **maximum** request cost from prompt token estimate + output cap + expected/limited tool/retry fan-out + safety checks. For long workflows, reserve a bounded step, then require reauthorization for the next step.
3. Atomically verify all relevant limits and funding pools (org/course/person/model/workflow), allocate a reservation with TTL, record action and `requestId`.
4. Hall Monitor evaluates mandatory input under protected safety pool. Return action; if `block/hold`, release unnecessary generative reservation (but keep actual safety spend).
5. For `allow/coach`, execute exactly the approved model/tool scope. Record every provider attempt with vendor IDs and returned usage. Before starting another model step, reserve more capacity if needed.
6. Settle used amounts once; release unused reservation; retain `pending_unknown` if provider timed out after accepting work. Run asynchronous reconciliation and cashflow corrections.
7. Emit a user-facing remaining budget and an auditable receipt. Keep price-book/routing revisions pinned.

**Do not allow a parent budget to be exceeded by parallel children.** Test with 100 concurrent requests and an intentionally tight course budget. Deduplicate event retries, but do not suppress a truly separate billable provider retry.

### Special treatment of mandatory safety

Mandatory baseline Hall Monitor runs are charged to the safety budget irrespective of the student's available model balance. If safety spend reaches its administrative alert threshold, alert and slow non-critical bulk evaluations; for student-facing AI with required moderation and no safety capacity, suppress generative AI access and provide a safe non-AI or human-supported path. Never waive a required safety check just to reduce costs.

### Recommended pilot caps (hypotheses, not prices)

| Budget | Proposed control | Notes |
|---|---:|---|
| Standard active teacher | $15/month | Model-class allowlist; advanced staff preset $30; curriculum specialists separate pool |
| AI-enabled student (grades 6–12) | $2/month | Teacher/district approval, bounded tutoring profiles; optional enhanced $5 |
| Assessment CI | $0.25 per rostered student/month | Shared course or organization pool; cap evaluator retries |
| Hall Monitor safety | **minimum $5/organization-month or $0.10/AI-enabled user-month**, whichever greater | Budget reserve, not expected cash bill; subject to pilot measurements |
| Content Studio vetting | Configurable authoring pool | Separate from student chat and mandatory safeguarding |

A student's personal workspace does not itself grant an AI allowance. Fund model requests only when policy explicitly authorizes an AI activity.

## 7. Gateway and provider attribution

**Best-practice defense in depth:** authoritative district budget ledger + Cloudflare AI Gateway spend rules/rate limits + provider account quotas. Gateway spend limits are **eventually consistent** and based on costs booked *after completion*; concurrent burst traffic can overrun them. They are a backstop, not the sole cap. Cloudflare Gateway can scope by provider/model/metadata, within rule-count limitations. Use synthetic cost limits in staging to confirm expected `429` behavior.

When possible, send `cf-aig-collect-log-payload: false` for education content and preserve metadata-only entries for reconciliation. Payload disabling does *not* disable all logging; do not confuse it with `cf-aig-collect-log: false`. Verify account log retention mode (new gateways use Workers Logs, older gateways Legacy Logs). Plan for changes in observability pricing. The ledger must not depend on arbitrary retention of external Gateway logs.

For direct Workers AI calls through a binding, collect usage and neuron estimates at the authoritative provider adapter; periodically compare with Cloudflare account-level analytics rather than depending on an AI Gateway log existing for every request.

## 8. Reconciliation algorithm and discrepancy policy

Nightly (or at the vendor's supported cadence) reconcile:

`application_receipts -> Hall Monitor receipts -> AI Gateway/provider usage -> Cloudflare daily analytics -> provider/Cloudflare invoices`

Match by `providerRequestId`, `aiGatewayLogId`, request metadata or safe timestamp/model/service grouping. A `requestId` may have many `attempt` rows. Preserve a complete mismatch set; don't silently overwrite original counters or assume vendor bills are exact per student.

- **Granular inference:** reconcile request/token totals where provider data supports it. `status = reconciled` only when a reliable matched usage record exists.
- **Cloudflare infra:** reconcile *account-period aggregates*, then allocate by an explicitly chosen policy (`metered marginal`, `gross usage`, `flat shared overhead`, or `capacity reservation`). Infra per-student cents are **allocated costs**, not directly itemized Cloudflare invoices.
- **Included usage, grants and fees:** apply after gross usage aggregation. Model list-rate cost and actual invoice remain separate fields. Do not apply the $5 Workers plan fee per Worker if Workers billing is account-scoped. Do not subtract the same included 10,000 Neurons/day in Hall Monitor and EducateOS independently when they use one account.
- **Discrepancy thresholds:** proposed warning if `abs(actual - forecast) > max($5, 5% of actual)` per SKU-day with sufficient sample size; manual investigation if sustained for 3 days; financial cutoff for significant unmatched invoice lines. These thresholds must be tuned by pilot size. For small tenant low-spend scenarios, report unmatchable percent and significant outliers rather than expecting request-perfect records from aggregate invoice datasets.
- **Refunds/credits:** append correction transactions with origin references. Never rewrite historic settled events.

## 9. What the dashboards must show

**District owner/admin:** actual provider bill, projected spend, teacher/student/Assessment/Hall Monitor usage, model-mix, forecast variance, grant funding, hard-limit health, infrastructure COGS, outstanding reconciliation, no raw student chat.

**School principal:** school, course and aggregated class costs, allocations and safety service *availability*, not student crisis chat contents.

**Teacher:** own remaining AI allowance, class-level assignment/CI consumption, permitted student activity spend categories; no unrelated student personal workspace text.

**Student / parent (if enabled):** clear remaining permitted AI balance and explanation that safer guided modes may be used. No stigma from moderation event counts.

**Managed operator:** tenant-level aggregate chargeback, contractual entitlements, monthly cost-to-serve, infra per active course, model mix, support overhead. Do not expose private student traces.

## 10. Backfill and compatibility

PlayTrek currently has `packages/db/src/schema/ai.ts` `aiGenerations` rows containing `usagePromptTokens`, `usageCompletionTokens`, `costUsd`, provider/model and identifiers, but this is not yet the proposed unified immutable usage/price-book ledger. Backfill at `status=legacy_estimate` with provenance; do not claim cached-token precision or request-level provider validation if absent. Treat raw prompt/response columns as sensitive and migrate them *separately* under retention policy, never into the cost ledger.

Cloudflare OS's existing `docs/ai-gateway-billing.md` implements per-user daily **call** allowances and optional personal Cloudflare Gateway credits, not district-level reserve/settle budgets. Preserve upstream behavior where useful but **do not substitute call caps for USD budgets**. The EducateOS feature adapter can populate both systems during migration; prove no double billing and choose one authoritative owner for every billable model call.

## 11. Testable finance acceptance criteria

1. Same event delivered 10× leaves one logical billed usage record and one budget settlement.
2. An actual provider retry that ran twice creates two attempt charges under one parent user request.
3. Two concurrent high-cost requests cannot each consume the same final $0.01.
4. A parent budget with children does not overspend; budget debit/credit ledger invariant holds after forced process restarts.
5. Cached input tokens never count both as cached and uncached.
6. Missing provider usage leaves a marked liability, not `$0`.
7. Mandatory Clef spend continues from the safety pool even if discretionary student wallet is exhausted; further generative calls are correctly blocked.
8. Same billing account with multiple products consumes **one** Workers AI free daily allocation, while each product's gross cost is still visible.
9. Financial reports are reconstructable from events and price-book versions and omit raw content.
10. A root `educateos.io` outage cannot change the district's budget enforcement semantics.
