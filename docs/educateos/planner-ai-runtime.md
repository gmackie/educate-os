# Governed planner explanations (SCHO-431)

The district Worker now supplies `plannerExplanation()` with a concrete Workers AI binding
adapter. `DistrictObject` injects `PLANNER_AI` and `PLANNER_AI_GUARD` through `startDistrict`;
missing bindings leave reviewed curriculum fully usable. No production deployment or paid
live-model smoke test is included in this WIP. The Workers tests exercise this path with a
recording model binding and guard, including real SQLite, policy changes and teacher privacy.

## Enable only for an authorized district pilot

1. Start with [the disabled sample](examples/planner-ai.disabled.json) as `DISTRICT_CONFIG.plannerAi`.
   It has no grants. Its prices are illustrative, **not verified provider rates**: replace the book
   with reviewed current input/output rates before enabling. Expired or incomplete rates deny.
2. The installer must supply a Workers AI binding named `PLANNER_AI` in the district's account
   (Wrangler shape `ai: { binding: "PLANNER_AI" }`), and a service binding named
   `PLANNER_AI_GUARD` to the existing guard Worker's `EducateOsAiCallGuard` entrypoint. Add these
   through the Worker's `cloudflare.config.ts` source and regenerate configs; never hand-edit a
   generated Wrangler file. No default configuration enables or provisions these bindings.
3. Provision the named Cloudflare AI Gateway with payload logging and caching disabled. The adapter
   additionally sends `collectLog:false`, `skipCache:true`, a six-second gateway timeout and
   `maxAttempts:1`. Workers AI authorization stays inside the platform binding; there is no model
   API key in policy, browser state, prompts, output, audit records or application logs.
4. List `cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast` in the district model catalog and the
   course funding pool's allowlist. Configure the existing guard's same model/rates, student input
   and required output screening, funded safety pool and trusted district context resolver.
   The guard resolves `principal:<id>` from the live directory; this non-Workshop planner call has
   **personal** context there. Its personal generative pool must also allow/fund the model.
   The district planner ledger reserves against the **course** pool. Both independent gates must
   allow; their reports describe the same generative request and must not be summed as two vendor
   calls. The guard additionally accounts for moderation. Missing guard/personal funding denies.
5. Apply district policy permitting `aiHelp: full` and AI spending, subject to school/offering
   restrictions and per-principal monthly caps. Conservative defaults remain hints-only and deny
   generated explanations. `aiSpending: disabled` is the live kill switch. Deployment permission
   alone cannot override that policy, a disabled model, an exhausted pool or a monthly quota.
6. After external verification of guardian AI-processing authorization, add a dated grant:
   `{ "studentId": "prn_<district-student>", "guardianAuthorized": true,
   "grantedAt": "2026-11-15T00:00:00Z", "expiresAt": "2026-11-22T00:00:00Z" }`.
   Set `enabled:true` and select the intended `offeringIds` only after completing those prerequisites.
   The student must also explicitly select the optional AI checkbox and press **Show me how**;
   the checkbox resets after each request. Hints/next/challenges never trigger model calls.

This is a minimal deployment-controlled grant list, not a child enrollment or consent collection
platform. Guardian authorization is required for **every** student, including grades 6–8 where age
under 13 cannot be inferred reliably from grade. All known active course grade bands must be
6–12; K–5, mixed/unknown bands, public callers, inactive/non-enrolled callers and absent, future,
expired or revoked grants deny. Do not enroll real children based solely on this sample; the
operator must verify authorization and the district guard/Hall Monitor's source eligibility policy.
There is no public or under-13 unconsented generative AI path.

## Limits, accounting and failures

Only the fixed model above is supported. Each explicit request makes at most one model call,
without tools, agents, retries or chat history. The prompt contains only the bounded learner goal,
standard code/URI, pinned release digest, step and curriculum instruction. Total message text is
capped at 16,000 UTF-8 bytes, output at 600 tokens, and the raw response at 32 KiB. There is an
18-second adapter deadline and 20-second planner deadline; aborts with uncertain provider usage
retain the reserved maximum as an unknown-cost liability. No model text is released after abort.
Known usage is estimated from the reviewed price book and records its ID; it is not asserted to
be an invoice. The existing guard performs its own settlement. No-send refusals release the local
course hold; guard denials release their own hold through the existing guard implementation.

The district SQLite record table stores only content-free runtime limits in collection
`planner-ai-runtime`. Key `student:<principalId>` holds day/count/nextAt: one admission per minute,
at most the configured 1–20 per UTC day. The counter survives adapter/object recreation. Three
upstream failures open a district breaker for one minute. These limits include failed/denied
admissions, so repeated attempts cannot evade quotas by creating new plans. A failed/rejected
response always leaves deterministic coaching available. Model/guard error strings are discarded.

Consent and the live district policy are rechecked after guard I/O, before send, and before release.
To revoke, remove the grant or set `revokedAt` and update the district deployment configuration;
any `revokedAt` value denies. Disable all planner calls with `plannerAi.enabled:false`, or disable
AI spending through the applied district policy. Deployment changes take effect on the new Worker
version; the applied spending policy takes effect without a redeploy.

## Threat model and privacy handoff

Student goals are untrusted prompt data. The fixed system instruction tells the model to ignore
instructions embedded in that data. Prompt instructions alone are not a security boundary: output
must pass strict schema/alignment checks **and** the existing guard's output screen before release.
Extra properties (including mastery), changed URI/digest/step, malformed JSON, excessive output,
missing usage, guard failures and withheld responses never replace curriculum. Accepted output can
only change coaching guidance and its help provenance. It cannot write tasks, alignment, evidence
contracts, assessment results or mastery. Plain text rendering prevents model-supplied markup from
becoming executable UI. Model explanations can still be factually wrong; the student UI says so.

Private goals, explanations and chats are never added to teacher dashboards. Teachers continue to
receive only explicitly shared evidence and existing content-free help summaries. Independent
mastery still requires the separate teacher assessment pipeline.

For `feat/plp-student-data-lifecycle` integration: grants are explicitly scoped by `studentId` in
`DISTRICT_CONFIG.plannerAi.grants`; subject purge must remove that subject's deployment grant and
update configuration, in addition to deleting the `planner-ai-runtime` record whose key is
`student:<principalId>`. No separate consent table or browser-writeable grant endpoint exists.
The district-global `breaker` key contains no subject. Ledger/guard retention follows their
existing audit retention rules; this branch does not claim to implement subject purge.
