# 05 — Operating Model, Quality Gates, Observability, Privacy and Test Plan

## 1. Roles and accountability

| Role | Owns |
|---|---|
| District/co-op billing administrator | Organization caps, funding policy, actual vs forecast, commercial reconciliations |
| Curriculum/teacher administrator | Review of approved educational resources, course policy within district floors |
| Hall Monitor service maintainer | Service SLOs, model benchmarks, policy-pack releases, input/output guardrail operations |
| Privacy/safeguarding officer | Data handling, human-review access, sensitive incident policy, retention/erasure and reports |
| PlayTrek/SchoolOS app maintainers | Trusted ingress enforcement, identity and subject claims, product-specific adapters, user UX |
| Finance operator | Price book provenance, account bill import, cash vs cost attribution and credits |

For a very small co-op one person may wear several administrative hats, but the technical access rights should remain separable. Nothing should automatically grant a teacher unrestricted access to a child's private AI conversations merely because the teacher can see assignment progress or class AI spend.

## 2. Metrics, not content surveillance

### Service reliability

- `hallmonitor_evaluations_total{kind,policy_profile,decision,service,product}`
- `hallmonitor_evaluation_duration_ms` p50/p95/p99 by model and kind
- `hallmonitor_provider_errors_total{provider,reason}` and `escalations_total`
- `hallmonitor_timeout_total` and `fallback_path_total`
- `hallmonitor_policy_revision_active`, `hallmonitor_client_revision_active`
- `hallmonitor_unmoderated_attempts_prevented_total` (synthetic tests and verified enforcement, not raw content)

### Spend and unit economics

- `usage_request_count{product,purpose,model,provider,tenant}` and `usage_prompt_tokens`, `usage_cached_tokens`, `usage_output_tokens`, `usage_neurons`
- `budget_reserved_usd_nano`, `budget_settled_usd_nano`, `budget_remaining_usd_nano`
- `gross_model_cost_usd_nano` and `net_vendor_invoice_usd_nano` (never add one to the other)
- `cloudflare_worker_cpu_ms`, `cloudflare_do_active_gb_s`, `cloudflare_artifacts_ops`, `cloudflare_r2_gb_month`
- `invoice_reconciliation_delta_usd_nano`, `unknown_cost_attempts`, `provider_usage_missing_count`
- `moderated_inputs / generative_model_calls`, `moderation_gross_usd / user_visible_student_activity`, `ci_usd / submission`

Keep high-cardinality request/principal identifiers **out of Prometheus metric labels**; store them in access-controlled ledger tables. For browser and billing dashboards, aggregate by safe dimensions. Include quality/reliability counters to detect drift without recording private chat bodies.

## 3. Draft SLOs and alert policy

SLOs should be calibrated using real tests, not announced as vendor commitments. Initial operational guardrails:

| Signal | Draft warning | Draft page/escalation | Behavior |
|---|---|---|---|
| Mandatory input moderation availability | 99.9% rolling 7d target | 15-min elevated failures affecting enabled student modes | Pause new generative child AI, maintain safe manual paths |
| Clef classifier p95 added latency | Above measured baseline +50% over 1h | Sustained breach affecting class sessions | Investigate routing/region, disable nonessential bulk reviews |
| Escalation rate | 2× observed baseline for a profile (minimum sample) | Unexplained high-risk shift sustained for days | Review model revision and false-positive samples via synthetic QA |
| Student or teacher pool utilization | 70% info, 85% warn | 100% (nonessential requests denied) | No emergency spend from children's wallets |
| Hall Monitor safety-pool utilization | 70% info, 85% urgent | 95%: alert admin; plan uplift | Safety operation stays separate; no bypass |
| Reconciliation mismatch | `> max($5,5%)` on sufficiently large SKU-day | Repeated 3-day drift | Finance investigation; mark report as provisional |
| Unmatched cost records | >1% of model attempts after reconciliation delay | >5% sustained | Fix provider adapters, review possible overspend |
| Root offline test | Any class dependency on schoolos.dev | District learning/guardrails fail when root is down | Architectural blocker |

The financial thresholds are proposed for initial pilots; a $0.95 moderation month cannot meaningfully be monitored using a $5 absolute discrepancy threshold alone. Use event completeness and provider-neuron reconciliation when spending is small.

## 4. Daily/weekly/monthly recurring operations

**Every request:** Authenticate, resolve policy revision, check relevant budgets, record reservation, evaluate/infer, settle counters and write content-free receipts; expose a stable request ID to authorized troubleshooting tools.

**Every day:** Pull available provider usage and Cloudflare analytics; check unmatched attempts, saturation, account-wide Workers AI Neuron allowance and spend alerts. Flag rate changes. Check traffic anomalies or unreviewed policy revisions. Human-review cases must follow separately defined authorized-access procedures.

**Every week:** Quality regression on a frozen synthetic corpus; check false positive/negative rates by policy profile and language, audit student ingress coverage and no-payload-logging settings, run cost efficiency/reporting checks. Review spend per real educational activity and hidden model fan-out.

**Every month:** Lock immutable invoice period; import Cloudflare/provider actuals, allocate shared baseline/included usage/credits, publish co-op/district finance report, apply policy adjustments with audit, refresh price book, review model mix and budget caps, validate retention/erasure processes. Before the December 2026 observability pricing change, update logs price assumptions.

## 5. Privacy and data-handling matrix

| Data | Default location | Default retention goal | Access |
|---|---|---|---|
| User input and model output for moderation | Memory of district/managed authorized Worker and inference provider | Not stored by Hall Monitor by default | Application user and model-processing contract only |
| Minimal moderation finding | Billing-owner local audit storage | Short, documented institutional retention | Approved operators; no generalized browsing |
| Safety review packet for human intervention | Separate encrypted reviewed-case store | Minimum legal/institutional period; policy-defined | Explicit safeguarding role and audit |
| Token/cost usage receipt | Billing owner local ledger | Financial audit period under policy | Finance/reporting roles; never prompts |
| Teacher/course workspace data | SchoolOS district/organization account | Course/workspace retention policy | Student/teacher/course-specific permissions |
| PlayTrek game student record | PlayTrek-controlled tenant data plane | PlayTrek educational record policy | Appropriate PlayTrek/organization roles |
| Shared public policy/evaluator bundle | Signed release/artifact registry | Release history | Authorized public/policy publishers |
| `schoolos.dev` root registry | Tenant/fleet aggregate only | Fleet/subscription policy | Operator + tenant owner; no child prompts |

Before enabling child input: execute legal counsel/privacy-officer review for COPPA/FERPA applicability, appropriate parental consent/contractual relationships, vendor DPAs, modality handling, teacher/support access, purpose limitation, and deletion pathways. A child-safe classification profile does **not** itself establish legal compliance.

## 6. Testing tiers

### Level 1 — Pure deterministic policy tests

- Strong policy floors: a teacher/course cannot weaken district mandatory student filtering or change grant boundaries.
- Adversarial role/tenant claims: clients cannot self-assert being teachers or route a student's request through educator profile.
- Typical allowed academic topics remain allowed even when sensitive terms occur in history/health/literature contexts.
- Direct-answer requests in graded contexts return `coach` with a reason; benign academic follow-up remains usable.
- Distress situations are routed to `support` and never casually treated as misconduct.
- Exact same policy revision + findings always produces the same enforcement action.

### Level 2 — Clef classifier regression

- Frozen anonymized/synthetic corpus labelled by trained reviewers, subject/age/language and expected action.
- Multi-turn context, indirect prompt injection in a quoted PDF or web document, and social-engineering attempts through tools.
- Ambiguous categories and calibration curves; record **precision and recall per category**, not a single top-line accuracy.
- Bounded request token sizes and per-modality tokenization; verify pricing unit conversion.
- Provider 429, malformed result, timeout, network interruption, model version mismatch.

### Level 3 — Budget/ledger correctness

```text
Case: organization $1.00 funded
  100 concurrent requests each request $0.20 maximum
Expected: <=5 admitted; at most $1 reserved+settled combined
No unknown provider attempts can silently become $0
```

- Duplicate settlement 20× = one logical settled event, not 20 charges.
- One user request that genuinely creates 3 provider attempts = 3 usage events, one parent operation.
- Budget reserve timestamp and expiration, partial stream settlement, provider accepted work but client connection lost.
- Closed month historical price book does not mutate after published tariff update.
- Same-account Workers AI inclusion applies once across Hall Monitor and both products.
- Managed chargeback excludes student prompts and unauthorized tenant records.
- Randomized unit arithmetic vs independent Python/decimal oracle under millinanodollar or $0.01 rounding policy.

### Level 4 — Product ingress integration

**SchoolOS:** first/new chat, subsequent turn, live steering, slash command expansion, agent tool use, model binding, uploaded attachment and external message queue, content import and generated worksheet. Must cover the actual trusted RPC handler rather than only frontend hooks.

**PlayTrek:** episode generation, Hall Monitor content review, rejected/repair iterations, rule-set changes, optional learner interaction, voice/media generation and provider fallback. Assert no double-counting when PlayTrek retries local validation.

**Both:** root outage, product restart, Hall Monitor version rollback, provider outage, code downgrade, asynchronous reconciliation; input without moderation does not reach unauthorized model.

### Level 5 — Business acceptance

- The 120-student homeschool example regenerates workbook totals and Hall Monitor add-on within documented rounding tolerance.
- An admin can tell **gross model rate cost**, **net actual Cloudflare bill**, **shared included allowance**, **safety reserve**, and **student/teacher remaining balance** apart in the UI.
- Billing owner can disable all student AI while preserving instructor curriculum generation.
- Curriculum editor can import/publish a subject-neutral learning resource with a teacher review and cost receipt.
- Moderator failure produces a clear safer workflow, without a hidden unmoderated path.
- Test data only; no production student records used during synthetic acceptance runs.

## 7. Incident-response runbooks

### Safety model false negative or policy bypass

1. Narrow/disable affected student AI feature or model route immediately; continue non-AI activities.
2. Preserve minimal incident metadata and authorized restricted evidence, not a broad private-chat export.
3. Establish entrypoint cause, affected tenant/policy/model release and other possible exposures.
4. Notify responsible institutional safeguarding/security leads per approved procedure; do not auto-message every teacher/parent on a classifier score alone.
5. Add regression fixture, fix policy/ingress, validate, then reactivate after approval.

### Inference cost spike / provider rate change

1. Freeze optional premium model/classroom workloads using platform model allowlists and budget caps.
2. Keep mandatory safety budget operational or suppress student generative access safely if not feasible.
3. Compare ledger attempt fan-out, cache accounting, Gateway logs, provider billing and account neurons.
4. Publish an incident cost reconciliation showing list-rate, actual invoice, credits, uncertainty and tenant allocations.
5. Tune model routing or per-call limits; don't silently change historical receipts.

### Ledger or provider reconciliation outage

1. Continue within a conservative, locally reserved funded escrow for nonessential activity, or temporarily reject new spend if guarantees cannot be honored.
2. Queue signed idempotent usage receipts and checkpoint consumer offsets; preserve original timestamps.
3. Reprocess with duplicate protection and settle unknown outcomes after provider confirmation.
4. Mark dashboard as `provisional` until invoice reconciliation resumes.
5. Never add missing amounts as `$0` and never re-admit spent student budget after a process restart.

### Hall Monitor service unavailable

1. Treat mandatory student AI as unavailable; surface bounded safe alternative/teacher contact and a non-AI learning path.
2. Optional educator-only low-risk workflows may follow a separately approved deterministic fallback; don't automatically downgrade all safety policies.
3. Check secret expiry, policy signature, Workers AI account binding, regional 429 and service status.
4. Restore a last-known-good signed policy/evaluator release and run acceptance probes.
5. Count outage and visible user impact; do not fabricate moderation token usage for requests never sent.

## 8. Change management and rollout policies

Policy, model, service and price book versions change independently:

- **Policy release:** Signed manifest, effective date, approval authority, class-district inheritance, migration/rollback and expected decision-difference report against frozen fixtures.
- **Model release:** Selective canary on synthetic or duly authorized traffic, safety regression and gross cost comparison, then staged upgrade; support rollback.
- **Price-book release:** Direct official/contracted source, snapshot/effective interval, finance review; historic receipts immutable.
- **SDK/API release:** Semantic versioning, compatible rollout windows, refusal of unsupported safety-critical schema, no silent inference bypass.

Prefer **shadow-mode evaluator comparison** in staff-only or synthetic contexts before student deployment. A classifier may show high benchmark accuracy while failing on actual grade-banded, curriculum-sensitive contexts; production permission is a separate decision.
