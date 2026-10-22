# SchoolOS AI call guard

`schoolos-ai-guard` is the Worker that implements the Workshop's optional `AI_CALL_GUARD` seam
(`@gadgets/workshop-shared/ai-call-guard`) for SchoolOS, as [ADR-0007] describes. The backend binds
its `SchoolOsAiCallGuard` entrypoint as `AI_CALL_GUARD` and asks it before and after every model
call. The guard does three things:

1. It holds the call's maximum cost against the principal's generative funding on the district
   ledger, and settles it with the actual usage once the call ends.
2. It sends each new message's text to [Hall Monitor] and applies the decision.
3. When the profile requires output moderation, it has the Workshop hold each model response and
   screens it with Hall Monitor (`interaction.output`) before any of it is shown.
4. It pays for each Hall Monitor check from the protected safety pool, never from a student's
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

A deployment that lets the guard read its AI Gateway's logs sets `AI_GATEWAY_ACCOUNT_ID`,
`AI_GATEWAY_ID` (vars) and `AI_GATEWAY_LOGS_TOKEN` (a secret API token with AI Gateway read
permission). They are optional, so they are not wizard inputs; without all three, settlements are
estimated and nightly reconciliation only records snapshots.

The Worker has one Cron Trigger, `17 3 * * *` (nightly, UTC), declared in `cloudflare.config.ts`.
The release manifest carries it as the entry's `crons`.

`AI_GUARD_CONFIG` holds:

- the district's funding pools (one of them the safety pool), model catalog and policy floor;
- the district's directory snapshot, only when no district app is bound as `SCHOOLOS_DISTRICT`.
  With the binding, both the context resolver and the ledger read the district's own directory,
  the ledger's with every principal's display name and email stripped (`ledgerDirectory`). The
  resolver looks a call up by its Workshop user (`guardSubject`), and a screened response by the
  principal and workspace its reservation records (`admittedSubject`);
- a rate table for each model;
- the moderation model, the most one check may cost, and the Hall Monitor tenant and cost center;
- guard profiles: a Hall Monitor policy profile revision, whether input is moderated, a
  `failureMode`, and `outputModeration` (`required`, `optional` or `off`, default `off`, mirroring
  the Hall Monitor profile), one for each audience class (`student-k5`, `student-6-8`, `student-9-12`,
  `educator`);
- when no district app is bound, the district's workspaces and its administrator-confirmed
  Workshop user links (see below);
- `contextSource`, `district` by default. `static` reads hand-written `principals` bindings
  instead, and is for tests and local development only.

It is validated strictly, and an invalid config makes every call fail closed. Workers vars are
limited in size, so a whole directory snapshot only fits a small district; a deployment that
runs the district app should bind it instead (follow-ups).

## Who a call is for (SCHO-132)

The kernel names only its own authenticated user (`AiCallDescriptor.initiator`). The guard asks
the district who that is, through the district app's guard read model (`GuardDirectory`, the
`@schoolos/district-app/guard-directory` entry). It is reached by the `SCHOOLOS_DISTRICT` service
binding when the deployment adds one, an entrypoint given to the guard alone and never on the
`/api` surface; otherwise the same read model runs in the guard over the configured directory,
workspaces and links.

- **Principal.** A Workshop user reaches a principal only through a `WorkshopUserLink` a district
  administrator confirmed (`confirmWorkshopUserLink` in `@schoolos/identity`). The key is matched
  exactly and never against a principal's email, a Workshop user with two links resolves to no
  one, and another district's links are ignored. Service principals are never Workshop users.
- **Workspace.** A gadget whose Workshop storage handle names a course workspace bills that
  course; any other gadget is the owner's personal workspace. A gadget whose workspace belongs to
  someone else is refused.
- **Audience and grade band.** Staff (teachers and administrators alike) are `educator`.
  A student's grade bands come from the course workspace's course, else their active courses,
  else their schools; the youngest decides the profile and the Hall Monitor band (`K-2`/`3-5` →
  `student-k5`, `6-8` → `student-6-8`, `9-12` → `student-9-12`). A student the directory places
  nowhere gets `student-k5`, the strictest, and no band is sent.
- **Refusals.** An unlinked user is denied (`unknown_principal`) with a message asking them to
  have an administrator link their account. An `agent` initiator names a model, not a person, and
  is refused (`agent_initiator`). An answer for another district's principal is refused, and a
  directory that fails or answers something malformed denies the call (`context_unavailable`)
  before anything is held. Nothing in a call's content, or anything a browser sends, says what
  role or grade a user has.

## Development and previews

`src/dev-worker.ts` is the guard as `pnpm dev-server --with-ai-guard` (or `SCHOOLOS_DEV_AI_GUARD=1`)
and PR previews run it. It is the production guard and ledger with three stand-ins, and is never
part of a release, whose entry is `src/worker.ts`:

- **Hall Monitor** is the in-process fake in `src/fake-hall-monitor.ts`, which the tests use too.
  It allows everything unless the text carries a marker: `[[block]]`, `[[hold]]`, `[[support]]` or
  `[[coach]]` picks that decision, `[[unpriced]]` reports an unpriced attempt, and `[[down]]`
  fails as an unavailable service (a student call then fails closed). So typing
  `[[support]] help` into a chat shows the supportive message.
- **`AI_GUARD_CONFIG`** defaults to `src/dev-config.ts`: the synthetic Northfield district, a
  personal pool and a safety pool, and a flat dev rate ($0.10 in, $0.40 out per million tokens)
  for every model in `SUGGESTED_MODELS`. It is built in code because it is over the var size
  limit. To price another model or try other pools, set `AI_GUARD_CONFIG` in the shell or the
  root `.dev.vars`; the dev server passes it through.
- **Every unbound user** resolves to the config's catch-all `"*"` binding, a moderated student,
  because dev and preview user IDs can't be known in advance. The production resolver never does
  this; it refuses unbound users.

The dev server binds the guard only when asked, so its default stays upstream's. Previews include
it unless `PREVIEW_AI_GUARD=false`: a SchoolOS preview should run guarded, as a district does, and
the development entrypoint needs no credentials, secrets or real spend. The guard preview deploys
alongside the gatekeepers and the backend's `AI_CALL_GUARD` is pointed at it.

## Decisions

- **Request IDs.** A generative reservation is keyed by the Workshop's `callId`, which is unique to
  each attempt; the kernel asks guards to settle by it. Hall Monitor check `j` of message `i` is
  `<callId>.m<i>.c<j>`. That ID serves as the safety reservation, the Hall Monitor `requestId` and
  its idempotency key, so a retried evaluation replays instead of billing again.
- **Order.** Generative funds are held first, so a call over budget costs no moderation. Checks
  then run in message order and stop at the first `hold`, `block` or `support`. A denied call has
  its generative hold voided. Moderation spend stays charged, because it was spent.
- **Rates.** `modelRates` is the deployment's rate table, merged with the shared Cloudflare price
  book (`PRICE_BOOK_CLOUDFLARE_2026_10_20`, SCHO-115). A model listed with a price book and rates
  is priced at them, since a contract price wins over a list price. A model listed without rates
  (a Workers AI model, say) is priced from the shared book, and is refused if the book has no
  rate for it.
- **Estimates.** A hold assumes `reserveInputTokens` of prompt at the dearer of the input and
  cache-write rates, plus the call's `maxOutputTokens` at the output rate (a shared-book model is
  held at the book's price for the same tokens). Calls with no output
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
- **Settlement.** The Workshop reports usage but no cost (SCHO-134). When the guard can read the
  gateway's logs and the call's log (`aiGatewayLogId`) already reports a cost, the attempt is
  `provider_reported` at that cost. Otherwise usage is priced from the merged rate table
  (`estimated`, with the rate's or the shared book's `priceBookId`). The Workshop's token counts
  are used either way, since only they split out the prompt cache. A log lookup that fails or
  times out (3 s) falls back to the estimate. With no usage, or no rate, the attempt is `unknown`. A failed or aborted call that reported no tokens is voided. Settlement
  happens exactly once per `callId`: a repeated outcome finds the call already settled, and
  concurrent repeats replay in the ledger.
- **Output screening.** A language-model call whose profile's `outputModeration` is `required` is
  admitted with `screenOutput`, so the Workshop buffers its response and calls
  `screenModelOutput(callId, output)` before showing any of it. `optional` and `off` stream
  unscreened. The guard finds the call by its generative reservation, which names the principal
  and workspace (so a principal may be bound to only one Workshop user), and evaluates each
  32,000-character chunk as `interaction.output` under check ID `<callId>.o.c<j>`, funded from the
  safety pool like an input check. `allow` and `coach` release the response; `hold` and `block`
  withhold it with the `outputWithheld` message; `support` withholds it with the supportive one.
  Hall Monitor unavailable, a safety pool that can't fund the check, or a call that isn't awaiting
  release withholds, whatever the profile's `failureMode`. The generative hold is left for
  `afterModelCall`, since the model billed the call either way.
- **Privacy.** Message text goes only to Hall Monitor. It is never logged or stored. Logs carry
  IDs, decisions, Hall Monitor reason codes and error codes only, and a test spies on the console
  to check this. Hall Monitor error messages aren't logged either, only their codes.
- **Initiators.** `user` and `gadget` initiators resolve by Workshop user ID; a gadget's calls are
  its owner's. An `agent` initiator names a model, not a person, so it is refused.
- **Nightly reconciliation** (`src/reconciliation.ts`). The Cron Trigger runs two idempotent
  steps against the district ledger:
  1. With gateway logs readable, up to 200 settled requests whose cost is still unknown, and whose
     attempts all name a log, are looked up. Those whose logs now report a cost are reconciled by
     request ID under `gateway-logs-<day>`. The hold they were charged as a liability is replaced
     by the billed cost through an adjustment entry, and their unknown flag clears; the settlement
     itself is never rewritten. Logs with no cost yet are retried on a later night.
  2. The month of the day just ended gets its cost and allocation snapshot (`costSummary`, with
     the net allocation when `cloudflareAccount` is configured), stored in the ledger object by
     month. It holds pool IDs and amounts only. An unchanged snapshot is not rewritten.

  Re-running a night appends and writes nothing. Importing the provider's or Cloudflare's bill
  is out of scope.

## Out of scope and follow-ups

- Passing an answer key with output checks, for Hall Monitor's answer-leakage evaluator. The
  Workshop knows no answer keys yet.
- Deploying the district app as a Worker with a guard-only entrypoint for `SCHOOLOS_DISTRICT`,
  and an admin route that confirms Workshop user links into its `workshopUserLinks` store. Until
  then the directory, links and workspaces are configured, and the var size limit remains.
- Importing the provider's and Cloudflare's bills on a schedule, and reading the nightly
  allocation snapshot from the admin console.
- Teaching the deploy service to set a worker's `crons`. Until then, the guard's Cron Trigger must
  be added by hand on an installed guard.
- Coaching prompts for `coach` decisions.
- Moderating attachments. Image parts are skipped; Hall Monitor accepts them only as digests.
- Teaching the hosted deploy service the `service` kind and its `backendBinding`. The SchoolOS
  district installer already does (`services` in the install config, SCHO-131; see
  `docs/schoolos/installer-permissions.md`), but the upstream Cloudflare deploy service is external
  to this repo, so a guard it installs must still be bound to the backend by hand.
- Exercising a real Hall Monitor from previews. They run the fake (see below), so preview
  moderation proves the wiring and the ledger, not Hall Monitor's classifiers.

[ADR-0007]: ../../docs/schoolos/adr/0007-hall-monitor-and-ai-call-guard.md
[Hall Monitor]: https://github.com/gmackie/hall-monitor
