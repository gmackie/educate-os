# SchoolOS AI call guard

`schoolos-ai-guard` is the Worker that implements the Workshop's optional `AI_CALL_GUARD` seam
(`@gadgets/workshop-shared/ai-call-guard`) for SchoolOS, as [ADR-0007] describes. The backend binds
its `SchoolOsAiCallGuard` entrypoint as `AI_CALL_GUARD` and asks it before and after every model
call. The guard does three things:

1. It holds the call's maximum cost against the principal's generative funding on the district
   ledger, and settles it with the actual usage once the call ends.
2. It sends each new message's text to [Hall Monitor] and applies the decision.
3. It pays for each Hall Monitor check from the protected safety pool, never from a student's
   allowance.

The ADR names this package `@schoolos/hall-monitor`. It ships as `@schoolos/ai-guard` because it is
a deployable Worker and does more than call Hall Monitor.

The ledger is `DistrictAiLedger`, a SQLite Durable Object holding an `AiLedger` over
`@schoolos/ai-governance/durable-object-store` (SCHO-73). There is one object per district, named
by its district ID, and the guard reaches it through `ctx.exports`.

## Release and configuration

The release manifest has a `service` kind for this Worker (see `SERVICE_PACKAGES` in
`scripts/release/manifest-lib.ts`). A service is installable once. Its entry carries
`backendBinding: { name: "AI_CALL_GUARD", entrypoint: "SchoolOsAiCallGuard" }`, which tells the
deploy service (and the SchoolOS district installer) how to bind it to the backend. Its wizard
inputs (`deploy-inputs.json`) are listed below; none of them is OAuth:

| Input | Kind | What it is |
|---|---|---|
| `AI_GUARD_CONFIG` | var | The guard's configuration as JSON (the `GuardConfig` schema in `src/config.ts`). |
| `HALL_MONITOR_URL` | var | The Hall Monitor origin, reached over HTTPS. |
| `HALL_MONITOR_ISSUER` | var | The `iss` claim of service tokens. Hall Monitor must trust it. |
| `HALL_MONITOR_SIGNING_KEY` | secret | A private Ed25519 or P-256 JWK used to sign service tokens. |

A district that runs Hall Monitor in its own account can instead add a `HALL_MONITOR` service
binding, which the guard prefers. The config can't declare that binding, because its target is
not a Worker in this release. `HALL_MONITOR_AUDIENCE` defaults to `hall-monitor`.

`AI_GUARD_CONFIG` holds:

- the district's directory snapshot, funding pools (one of them the safety pool), model catalog
  and policy floor;
- a rate table for each model;
- the moderation model, the most one check may cost, and the Hall Monitor tenant and cost center;
- guard profiles: a Hall Monitor policy profile revision, whether input is moderated, and a
  `failureMode`;
- principal bindings from Workshop user IDs to SchoolOS principals.

It is validated strictly, and an invalid config makes every call fail closed. Workers vars are
limited in size, so a whole directory snapshot only fits a small district. The bindings and the
snapshot stand in for `@schoolos/identity` and the district app (see follow-ups).

## Decisions

- **Request IDs.** A generative reservation is keyed by the Workshop's `callId`, which is unique to
  each attempt; the kernel asks guards to settle by it. Hall Monitor check `j` of message `i` is
  `<callId>.m<i>.c<j>`. That ID serves as the safety reservation, the Hall Monitor `requestId` and
  its idempotency key, so a retried evaluation replays instead of billing again.
- **Order.** Generative funds are held first, so a call over budget costs no moderation. Checks
  then run in message order and stop at the first `hold`, `block` or `support`. A denied call has
  its generative hold voided. Moderation spend stays charged, because it was spent.
- **Estimates.** A hold assumes `reserveInputTokens` of prompt at the dearer of the input and
  cache-write rates, plus the call's `maxOutputTokens` at the output rate. Calls with no output
  cap, such as decision models, use `defaultMaxOutputTokens` instead. The guard sees only new
  messages, never the whole prompt, so the hold is deliberately conservative. Settlement records
  the actual cost even when it is larger than the hold.
- **Unknown models are denied** (`model_unpriced`) rather than estimated. Without a rate there is
  nothing to hold, and the spend would escape every budget.
- **Decisions.**
  - `allow` proceeds.
  - `coach` proceeds and is logged. Coaching prompts are a follow-up.
  - `hold` and `block` deny with a neutral message.
  - `support` denies with the configured supportive message, which points to a trusted adult and
    never scolds.
- **Safety pool exhausted.** The call is denied (`safety_budget_exhausted`) with the "AI isn't
  available, keep working without it" message. Moderation is never skipped to save money.
- **Hall Monitor unavailable.** A student audience fails closed, whatever its profile says. An
  educator follows the profile's `failureMode`, either `fail-closed` or `proceed`. A failed check
  may already have been billed, so it is settled as an `unknown` attempt: a liability at the hold,
  never $0.
- **Hall Monitor receipts** reach the ledger unchanged, since both use `UsdNano` strings.
  - Hall Monitor's input count includes cached tokens. It is split with `normalizeTokenUsage`.
  - An attempt with no price stays `unknown`.
  - A priced attempt with no token counts, such as one billed in neurons, is recorded with zero
    tokens and its reported cost.
- **Settlement.** The Workshop reports usage but no cost, so `afterModelCall` prices usage from
  the rate table (`estimated`, with the rate's `priceBookId`). With no usage, or no rate, the
  attempt is `unknown`. A failed or aborted call that reported no tokens is voided. Settlement
  happens exactly once per `callId`: a repeated outcome finds the call already settled, and
  concurrent repeats replay in the ledger.
- **Privacy.** Message text goes only to Hall Monitor. It is never logged or stored. Logs carry
  IDs, decisions, Hall Monitor reason codes and error codes only, and a test spies on the console
  to check this. Hall Monitor error messages aren't logged either, only their codes.
- **Initiators.** `user` and `gadget` initiators resolve by Workshop user ID; a gadget's calls are
  its owner's. An `agent` initiator names a model, not a person, so it is refused.

## Out of scope and follow-ups

- Output screening (`interaction.output`). The kernel shows the guard only inputs, so screening
  student-mode output needs a kernel seam that buffers output (ADR-0007, consequences).
- Wiring the context resolver and governance source to `@schoolos/identity` and the district app,
  in place of the configured bindings and snapshot. This also removes the var size limit.
- Pricing generative calls from the AI Gateway log (`aiGatewayLogId`) or a shared price book
  (SCHO-115), and scheduled reconciliation against the provider's bill (SCHO-115/116).
- Coaching prompts for `coach` decisions.
- Moderating attachments. Image parts are skipped; Hall Monitor accepts them only as digests.
- Teaching the hosted deploy service the `service` kind and its `backendBinding`. The SchoolOS
  district installer already does (`services` in the install config, SCHO-131; see
  `docs/schoolos/installer-permissions.md`), but the upstream Cloudflare deploy service is external
  to this repo, so a guard it installs must still be bound to the backend by hand.
- Including the guard in `pnpm dev-server` and previews. Both currently leave it out, so the
  backend runs unguarded there.

[ADR-0007]: ../../docs/schoolos/adr/0007-hall-monitor-and-ai-call-guard.md
[Hall Monitor]: https://github.com/gmackie/hall-monitor
