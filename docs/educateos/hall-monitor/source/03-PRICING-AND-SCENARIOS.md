# 03 — October 2026 Pricing, Scenario Economics and Sensitivity

**Basis:** The existing EducateOS workbook, `EducateOS_AI_Cost_Calculator_2026-10.xlsx`, is the baseline for *generative inference and Cloudflare app infrastructure*. This document layers a **new Hall Monitor operating model** onto that forecast. All examples are illustrative, not vendor quotes, measured production costs, or guaranteed safety-system costs.

## 1. Verified public price snapshot: October 20, 2026

| SKU | Published rate | Unit | Tracking implications | Primary source |
|---|---:|---|---|---|
| Clef-flash `@cf/cloudflare/clef-flash` | **$0.038** | Per 1M input tokens | Default typed text/image decision, no output charge | https://developers.cloudflare.com/workers-ai/models/clef-flash/ |
| Clef `@cf/cloudflare/clef` | **$0.240** | Per 1M input tokens | Escalation, no output charge | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Clef-omni `@cf/cloudflare/clef-omni` | **$0.150** | Per 1M input tokens | Audio/video/image input billed via modality tokenization; no output charge | https://developers.cloudflare.com/workers-ai/models/clef-omni/ |
| Workers AI | $0.011 | Per 1K neurons above shared daily free allocation | Track *neurons* and *effective bill*, not just equivalent token price | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Workers AI included usage | 10,000 | Neurons per account per UTC day | Shared by applicable Workers AI calls in account; never subtract once for each service | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| Workers Paid base | $5 | Per account per month | Avoid charging $5 for each extra Worker within same account | https://developers.cloudflare.com/workers/platform/pricing/ |
| AI Gateway core | $0 | Basic gateway service fee | Logs, guardrails, hosted models and inference can still have costs | https://developers.cloudflare.com/ai-gateway/reference/pricing/ |
| AI Gateway Unified Billing | 5% | Credit-purchase fee | Separate funding fee from per-call inference, avoid doubling | https://developers.cloudflare.com/ai-gateway/reference/pricing/ |
| Workers Logs as of 2026-10 | 20M included, +$0.60/M | Events/month on Paid | New gateways use Workers Logs; rates scheduled to change on **2026-12-01** | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| Artifacts | 10,000 ops, 1 GB included; +$0.15/1K ops, +$0.50/GB-mo | Account/month | Versioned curriculum and work; not per-student seat charges | https://developers.cloudflare.com/artifacts/platform/pricing/ |
| Containers | 375 vCPU-min, 25 GiB-h, 200 GB-h included; overages metered | Account/month | Applies to isolated Assessment CI, not normal Clef classification | https://developers.cloudflare.com/containers/platform/pricing/ |

**Pricing verification:** Cloudflare's Clef-flash price was cut on October 9, 2026; some older crawled or cached versions of the Workers AI pricing page still show $0.090/M. The **live** Workers AI pricing page and dedicated model page reviewed October 20 display **$0.038/M**. Pin this specific date and refresh the price book before rollout. Don't hardcode the provider's apparent `unit price` while also multiplying its neuron-equivalent charges: those are alternate displays of the same inference usage, not additive fees.

**Model menu pricing:** For teacher/student LLM inference, use the exact model and rate snapshots already linked in the workbook's **Model Prices** sheet (GPT-6 family, Claude 5.5, Gemini 3.1 Flash-Lite, Workers AI). Provider, model and region prices are separate from this Clef page; update independently when contracts or models change. Premium-model sensitivity is already in the workbook's **Model Sensitivity** sheet.

## 2. Baseline workbook inputs

From the existing **Role Workloads** sheet:

| Workload | Model calls / active person / month | Input / month | Output / month | Gross model spend / month |
|---|---:|---:|---:|---:|
| Teacher, blended model routing | 320 | 2,800,000 | 516,000 | $8.936 |
| AI-enabled student, grades 6–12 | 78 | 342,000 | 52,200 | $0.7044 |
| One Assessment CI evaluation | 1 | 8,000 | 1,200 | $0.028 |

These counts include **model calls**, not necessarily unique user-entered prompts. Moderation volume is separately instrumented and may be smaller (one moderation per user turn) or larger (input, tool, output and imported-media checks). For planning only, the scenario below uses the above call totals as a proxy for one *input moderation event* per model call.

The previous model also assumes 10% reserve on **generative** inference and estimates infra across Workers, DO, D1, R2, Artifacts, Dynamic Workers, Containers and AI Search. That infrastructure estimate is **not an additional $5 per Hall Monitor Worker** when the Worker is in the same Paid account.

## 3. Hall Monitor modeling assumptions (all editable)

**Baseline moderate-use model:**

- `moderated_messages = active_teachers*320 + active_AI_students*78`.
- **Input check:** 1 Clef-flash request per moderated message, including context/questions, **1,000 billed input tokens** on average.
- **Output check:** 1 Clef-flash request per moderated message, also 1,000 billed input tokens. Product policy may disable output moderation for selected educator-only uses, but not by accident.
- **Escalation:** **10% of moderated messages**, one Clef call each, **1,500 input tokens** (selective input-side escalation; not 10% of all output checks as well).
- **No image/audio/video in base calculation.** Multimodal checks can be materially more expensive due to input tokenization and preprocessing.
- **No extras** for bulk Content Studio/PlayTrek episode review, human review, model retries, latency/retries, or separate-account minimums in this table. Add those by changing inputs and measuring real request counts.
- Gross list-rate costs are computed **before** Workers AI daily free Neuron allocations and credits. This is intentional for reliable per-tenant/unit attribution.

### Formula and worked example

```text
flash_cost = messages * (input_check_tokens + output_check_tokens)
             / 1,000,000 * 0.038

clef_escalation_cost = messages * escalation_share * escalation_tokens
                      / 1,000,000 * 0.240

hall_monitor_gross_cost = flash_cost + clef_escalation_cost

# 12 teachers × 320 + 60 AI-enabled students × 78 = 8,520 events/month
flash_cost = 8,520 * 2,000 / 1,000,000 * $0.038 = $0.64752
escalation = 8,520 * 10% * 1,500 / 1,000,000 * $0.240 = $0.30672
HALL MONITOR GROSS = $0.95424/month
```

These model fees are tiny. **The dominant cost of an operational safety system can be the engineering, evaluation corpus, quality review, human escalation, service support and retention/compliance**, none of which is included in the $0.95 figure.

## 4. Five deployment scenarios including Hall Monitor

| Scenario | Active teachers | AI students | Modeled moderated messages/mo | Hall Monitor input+output Clef-flash (gross) | 10% Clef escalations (gross) | Combined HM gross | Previous total AI+infra | New AI+infra+HM gross |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Educator-only co-op (60 enrolled) | 6 | 0 | 1,920 | $0.14592 | $0.06912 | **$0.21504** | $68.69 | **$68.90** |
| Homeschool co-op (120 enrolled) | 12 | 60 | 8,520 | $0.64752 | $0.30672 | **$0.95424** | $184.11 | **$185.06** |
| Hybrid academy (500 enrolled) | 35 | 200 | 26,800 | $2.03680 | $0.96480 | **$3.00160** | $594.94 | **$597.94** |
| District (3,000 enrolled) | 180 | 1,050 | 139,500 | $10.60200 | $5.02200 | **$15.62400** | $3,234.26 | **$3,249.89** |
| Managed: ten co-ops (1,200 enrolled) | 120 | 600 | 85,200 | $6.47520 | $3.06720 | **$9.54240** | $1,868.12 | **$1,877.66** |

**Interpretation:** The last column is a *cost-to-serve forecast*, not a fresh Cloudflare invoice or a price quote. It adds list-rate moderation charges to previously modeled inference + Cloudflare infrastructure but does not add another base Workers Paid subscription. Actual net provider charges may be lower because 10,000 daily Workers AI Neurons can be free at the account level. If Hall Monitor is deployed in a **different** account, include that account's own relevant minimum/usage and platform support cost. The previous scenario totals already include 10% contingency on non-Hall-Monitor generative inference; add an explicit contingency to moderation if desired rather than pretending it is included.

## 5. Sensitivity curves to keep in the workbook

Use **rate times tokens times calls**, not a single “moderation $/student” constant.

| Change from base | Homeschool co-op Hall Monitor gross | Explanation |
|---|---:|---|
| Base: 1k tokens/check, 2 checks, 10% escalation | $0.95424 | Default estimate |
| Input checks only, same escalation | $0.63048 | Removes outgoing check cost |
| 500 tokens each input/output check | $0.63048 | Halves flash portion |
| 2,000 tokens each input/output check | $1.60176 | Doubles flash portion |
| 5% input escalation | $0.80088 | Halves Clef escalation share |
| 20% input escalation | $1.26096 | Doubles Clef escalation share |

This is deliberately **not** a calibrated moderation performance curve: decreasing prompt context may reduce quality. Each budget policy change needs safety evaluation alongside cost evaluation. A 1,500-token high-risk escalation prompt costs 15× as much as a 1,000-token Clef-flash call by unit price × token-count ratio; selective escalation still often keeps total spend low.

## 6. Cloudflare account boundary and shared free allocations

The Workers AI free allocation is **10,000 Neurons per UTC day**, shared by applicable usage in one Cloudflare account. A co-op running Hall Monitor alone may incur $0 net *Workers AI inference invoice* for that usage in some months, while the gross equivalent is $0.95. If PlayTrek game AI and EducateOS content generation use the same account's Workers AI, all draw from one free allocation. If Hall Monitor lives in a separate account it consumes that other account's allocation instead.

**Usage ledger policy:** Keep `gross_usage_usd`, `free_allowance_applied_usd`, `contract_adjustment_usd`, `net_invoiced_usd` separately. Apply any daily free Neuron pool **once per account/day**, then distribute the actual invoice *only after* the vendor's daily usage has been reconciled. Never produce fake student-specific invoice charges from shared allowances.

### Managed versus sovereign

- **Sovereign district:** Its own invoice for Workers, models and Hall Monitor; no dependency on `educateos.io`. EducateOS charges separately for software/support.
- **Managed co-op in pooled account:** EducateOS operator pays vendor account bill; cost ledger allocates *gross* service usage by tenant and optionally net bill by policy. Per-tenant data/secret isolation must be contractual and technical. Operator bills a predictable subscription or agreed consumption, not a misleading “Cloudflare charged exactly this student's amount.”
- **Managed co-op with dedicated account:** More isolation and potentially additional per-account included allowances, but more installation/update/account-management overhead. Compare fully loaded operations cost before picking.
- **Hybrid:** Institution owns generative provider keys while managed operator offers Hall Monitor; cross-account ingress must use signed HTTP and tenant-specific DPA/usage metering. Provider cost and Hall Monitor allocation may appear on different bills.

## 7. Budget planning versus expected expenditure

Using workbook pilot caps:

```text
Teacher allowance = $15 × active teachers
Student allowance = $2 × AI-enabled students
Assessment allowance = $0.25 × rostered students
Hall Monitor safety reserve = max($5, $0.10 × (active teachers + AI-enabled students))
```

For the 120-enrollment co-op: teacher $180, student $120, Assessment $30, Hall Monitor reserve $7.20 => **$337.20 total policy ceiling**. Expected cash operating expense under modeled activity is ~$185.06 **before** support, compliance, platform licensing and exceptional model usage. The $337.20 ceiling is neither a recommended sales price nor an invoice; it is the spending permission if all categories approach their caps.

Do **not** reduce a child's $2 discretionary AI allowance to pay for mandatory safety, and do **not** let all teacher + student hard caps sum beyond an organization's actual funded capacity unless the organization explicitly accepts this shared-budget/oversubscription policy. The org must have an overall cap that trumps all child allowances.

## 8. Non-inference cost centers that can dominate

| Driver | Why it matters | Measurement plan |
|---|---|---|
| Hall Monitor Worker CPU/requests | Often within a Paid account's included volumes, but not always | Requests, CPU ms, RPC/HTTP latency and origin account |
| Dedicated deployment/account | Separate account may add $5/month minimum and provisioning/support | Account and route ownership ledger |
| Workers Logs + AI Gateway metadata logs | Gateway log mode depends on when account first created a gateway; Workers Logs pricing changes in Dec 2026 | Count billable events and policy for payload-free logs |
| PlayTrek content-generation retries | Hall Monitor may reject/repair content several times, triggering additional **generative** calls | Count attempts; attribute generated content and rejected drafts |
| Safe outbound buffering | Changes response latency/Workers and DO active duration | Measure p50/p95 latency and DO duration |
| Human review | Often dramatically larger than Clef inference cost | Minutes/reviewer, case volumes, staff cost assumptions |
| Assessment CI | Container CPU/memory/disk and generative rubric evaluation | Runs × size × duration; model calls per run |
| Cloudflare Artifacts and R2 | Content history accumulates even if classroom is idle | GB-month, operations, retention, purges |
| Client-auth seats / third-party systems | Cloudflare Access can be expensive if used for all students | Account-specific contract and paid-seat count |
| Model changes | Premium text models can dwarf moderation costs | Existing Model Sensitivity sheet, per-user model allowlists |

**Security/performance:** Never silently stop moderation to avoid the cost. Prefer conditional content filtering, question bundling, efficient caching of *non-personal* source reviews, and teacher-only non-student-mode fallbacks. Cache keyed by content digest+policy+evaluator version, with explicit invalidation when policy changes; avoid caching personal safety judgments across distinct students.

## 9. Measurement uncertainty and update protocol

Tag every projected driver as `official_price`, `measured_pilot`, or `analyst_assumption`. In the pilot, record weekly measured:

- Real unique moderated user inputs vs agent-internal model calls, output checks per turn, total classifier attempts, average/p95 classifier input tokens.
- Escalation share, retries, model-prompt lengths and media request volume.
- Content Studio evaluations per teacher, PlayTrek generated episodes/repairs per student, Assessment CI jobs per submission.
- Worker/DO active time, R2/Artifacts, logs and search costs.
- Gross provider-rate cost versus invoice net, plus cost allocations and alert anomalies.

Re-run the workbook monthly using versioned price books and actual cohort data. Keep scenario assumptions separate from observed metrics. Review price updates at least monthly and any time a provider changes model/version or billing unit.
