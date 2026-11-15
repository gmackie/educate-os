# Teacher AI co-maintainer v0 — governed private suggestion preview

**Status:** Draft feature stacked on pedagogical intent contracts PR #36. It is not enabled in deployed district Workers by default and is not a publishing or classroom-update system.

## What it does

Teachers can request an AI suggestion for one exact OCS course unit, but only when their institution configures a trusted CourseIntentProvider. The server verifies the district-local OCS course and exact version, checks the caller's offering-level authoring permissions, and sends the provider *only* a tightly bounded source reference, unit title, unit summary, declared standards references, fixed adaptation goal and maximum output tokens. It sends no rosters, learner records, submissions, grades, teacher-only Codex bodies, or student assessments.

The first UI action is "Suggest low-equipment adaptation (AI)". The model produces a schema-validated PedagogicalIntentV0 with an origin of machine-suggestion, the exact original OCS package/version/digest/unit key, bounded learning goals and teaching strategies. Teacher Studio displays it as a private, unapproved draft. Nothing is saved, applied, signed, emailed or published.

This v0 intentionally uses predefined adaptation goals. It does **not** accept a free-text teacher instruction that might include student names or confidential records.

## Billing and safety

Each request is reserved under the existing AiRequestGovernor and district model catalog/funding pool policies. A provider must specify its allowed model and maximum price in nanodollars. The server refuses a declared ceiling above 10 cents and bounds each provider response to at most 750 output tokens.

On success the governor settles the provider-supplied reported usage/cost before a draft is returned. If a provider throws or cannot provide a valid settlement after it may have run, the request is recorded as an unknown attempt and charged against the maximum reservation for reconciliation; it is not silently treated as free.

A provider must not execute instructions appearing in course text. The provided title and summary are untrusted data, and provider prompt design must isolate them. An injected provider must authenticate and use its own account credentials; the browser cannot choose or override them.

### Important availability limitation

The current district application can use an injected CourseIntentProvider in tests and a future deployment, but the district Worker does not currently configure a production provider adapter or live model binding. Consequently the capability endpoint returns available=false in ordinary deployments and Teacher Studio hides the feature. Configuring a real Cloudflare AI Gateway or Workers AI adapter with accurate settlement, regional privacy terms, pricing and content-review safeguards remains a separate integration gate. Tests with synthetic provider responses are **not** evidence of live model inference.

The response is ephemeral. A future PR must implement durable district-private drafts, idempotency/replay protection against duplicate model calls, cancellable proposal review, and selected-change approval. Do not silently insert a generated activity into a classroom to make the demo more impressive.

## API

GET /api/teacher/offerings/:offeringId/course-library/ai-intent
  -> { available: boolean }

POST /api/teacher/offerings/:offeringId/course-library/ai-intent
  -> accepts exact packageId/version/unitKey and a fixed adaptation goal;
     returns an unapproved PedagogicalIntentV0 plus model and ledger cost info.

Both use existing teacher course authoring authorization. Students, guardians and other institutions cannot use these routes. A request referencing a unit not in the verified publisher release is refused before inference. A provider cannot rewrite the source identity, mislabel origin or declare independent verification.

## Acceptance and follow-on

- Unit tests with the district's synthetic cost governor and explicit fake provider.
- Wrong unit, student access, unsupported model and configured cost above limit rejected before model call.
- Malformed AI output charged/rejected; never trusted as authored or approved instructional content.
- No classroom content, assignments, assessment or grading writes in preview.
- Consent, copyright and data-minimization review before any external provider sees more than approved course metadata.
- Provider adapter with real AI Gateway/Workers AI credentials, accurate pricing and bounded retry.
- Persist private draft under district-owned storage after a *separate* reviewed PR, then provide human diff/accept/discard workflow; ensure a future publication action requires another explicit authorized step.
