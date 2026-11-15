# Opt-in Workers AI inference service for EducateOS Course Commons

**Status:** Implemented, unconfigured example. Not deployed, audited, or production-approved.
It uses the verified native Workers AI binding and a pinned gross price estimate.
See the official Workers AI [JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/),
[bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
and [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) documentation.

## Architecture

Teacher Studio -> district Worker class-scoped authorization -> AI spend governor
-> private COURSE_INTENT_INFERENCE service binding -> env.AI.run with bounded JSON schema
-> verified structured response + token-based gross price estimate -> ledger settlement
-> unapproved teacher suggestion.

This sample service **must not be exposed publicly**. Its own handler does not authenticate
staff: only a district-owned Worker may bind it, and that Worker MUST enforce policy and budget
before calling it. Configure the service and district deployment in the same Cloudflare account.

The example wrangler.jsonc has workers_dev:false and no public route. Do not override those
settings without adding an independent, reviewed authorization boundary.

## Deployment prerequisites (not automated)

1. Confirm model availability, applicable privacy/data residency and model licensing
   with the institution; approve any third-party processing.
2. Verify CURRENT pricing and response shape. The pinned price book is from the
   2026-11-12 Cloudflare price list for @cf/meta/llama-3.3-70b-instruct-fp8-fast:
   $0.293 per million input tokens and $2.253 per million output tokens.
   Calculated charges are **gross estimated inference costs**, not a claim about
   invoice amounts or free-allocation discounts.
3. Deploy this Worker in a district-controlled account with the Workers AI
   binding and **no public routes**; use the sample wrangler config as a starting point.
4. Extend the district's source cloudflare.config.ts / deployment generator to
   include a services binding named COURSE_INTENT_INFERENCE pointing at the
   new service. Do not hand-edit generated district wrangler.jsonc, which will
   be overwritten by the generator.
5. Set COURSE_INTENT_MODEL on the district Worker to exact deploy-time JSON:

    {
      "model": {
        "provider": "cloudflare",
        "modelId": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      },
      "estimatedMaxUsdNano": "100000000"
    }

6. Add the exact model to the **district-owned** model catalog and
   an approved funding pool. A binding alone must not enable AI spending.
7. Run synthetic tests and a privacy/security pilot before real teachers.
   Verify request limits, missing/invalid usage, model errors, invoice reconciliation,
   changing model rates, prompt injection, source mismatch and provider timeouts.

If the account has no paid Workers AI or the model/billing is unavailable, the
call fails and the district records an unknown attempt against the reservation,
never silently treating the failure as free.

## Model behavior and protections

- The request includes only the signed OCS source pin, bounded unit title/summary,
  approved metadata and a teacher-selected fixed adaptation goal. No student data,
  student work, grades, unreleased assessments or raw teacher-only notes.
- The service enforces a 12-KiB request cap, specific model ID, output token cap
  (750), structured response, exact source identity and prompt-as-data handling.
- The response has no raw inference log or prompt; errors are generic and
  never echo sensitive content.
- Workers AI may not always honor JSON Schema. Failure to validate is a
  failure, not an invitation to trust a malformed answer.
- The district remains the sole authority for curriculum drafts and review.
  The generated profile is not saved, approved, published or adopted by the
  service itself.

## Current limitations

No actual Cloudflare deployment has occurred here. The Worker does not provision
accounts, connect the service binding automatically, publish OCS packages, grant
teacher roles or run live model inference as part of CI. Receipt validation
is limited to model-reported token counts and a fixed gross price book; there
is no invoice reconciliation or provider receipt signature. Prompt wording
and model behavior must be evaluated with human educators before pilot.
