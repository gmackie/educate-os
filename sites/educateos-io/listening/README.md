# Adult founding-community listening (SCHO-430)

Public site: `/have-your-say/`, separate `/have-your-say/follow-up/`, and public
`/have-your-say/privacy/`. Implemented in the existing educateos.io Worker, outside district
release discovery (ADR-0013). Current verified repository identity: Gmacko Ventures LLC;
contact `hello@educateos.io` (existing intake notice and operator documentation). The foundation
is proposed, not a registered nonprofit. No pricing, tax status or legal certification promises.
No mail sender, CRM integration, marketing opt-in, student data, free text or public results.

## Architecture and controls

Reuse `INTEREST` / `InterestIntake`, its transactional `IntakeStore` and retention alarm.
Separate object names `community-listening-v1-survey` and `community-listening-v1-contact`
keep both kinds independent of existing interest intake and each other. Do not rename the Worker,
class or existing migrations. No new database, school-app authority or control-plane access.
Production persistence is Cloudflare SQLite Durable Object storage, never an in-memory fallback.

Survey choices are defined in `schema.mjs`; the HTML renders those same choices and the API
accepts only their exact values. All six questions are optional; adult and participation declarations
are required. Contact records contain only email, topic and explicit consent/declarations.
No shared survey/contact identifier or IP hash is included in records or exports. Submission times
and unusual choices may still allow inference; do not describe these responses as fully anonymous.

Bodies are streamed with an 8 KiB bound and strict known fields. Requests need exact canonical
origin, JSON, custom header and same-origin Fetch Metadata when present. Server validation
rejects children declining the adult declaration, missing consent and extra data fields. Adult
self-declaration is not age verification. Honeypots discard payloads. Turnstile uses exact
`educateos.io` hostname, `listening` action, timestamp <=300 seconds, timeout, replay prevention.
Secrets are independent of existing interest intake. No raw IPs, security tokens or payloads are
logged. There are no app logs on these routes. Errors are generic and JSON exports avoid CSV
formula interpretation. No cookies, analytics SDKs, browser persistence, or session replay.

Per store: <=10 attempts/IP/10-minute bucket, <=1,000 attempts globally/bucket before Siteverify;
<=500 accepted records/day; <=3 requests/contact email/day. Survey receipt is not an identity
or one-person-one-vote mechanism; rate limits and Turnstile reduce abuse, not sampling bias.
Apply zone WAF/body-size limits and capacity alerts before opening collection. IP rotation can
still incur cost. Staff must combine or omit small groups before publishing any aggregate findings.

## Publishing and rollout

The user explicitly approved merge/deployment on 2026-11-16 and confirmed their team monitors
`hello@educateos.io`, handles privacy/follow-up requests, and reviewed/accepted the published
notice and 90-day record/export/provider-recovery-copy procedure. That approval supersedes the
original PR-only merge restriction. Do not copy the old interest review attestation or enable its
unrelated funnel. The following prerequisites govern launch and any future reopening:

1. Confirm the operator identity/contact mailbox is current and monitored. Review notice,
   processor/international processing terms, 90-day retention, deletion procedure, staff access and
   backup/PITR handling. This implementation does not assert legal compliance or review completion.
2. In an isolated Cloudflare test deployment, prove real SQLite DO persistence after object restart,
   retention alarm delivery, transaction/idempotency behavior, private exports and erasure.
   The local `runtime-check.mjs` smoke proves SQLite restart persistence/export/erasure using real
   workerd; it does not prove deployed Cloudflare settings or delivery of scheduled alarms.
3. Provision a hostname-restricted production Turnstile widget for `educateos.io`, action `listening`.
   Configure public var `LISTENING_TURNSTILE_SITE_KEY` and secret `LISTENING_TURNSTILE_SECRET`.
   Production guards reject published Cloudflare test keys. Verify keyboard and challenge behavior
   with the real widget; offline browser tests stub only the security provider and API.
4. Set independent random >=32-character `LISTENING_HMAC_SECRET`, `LISTENING_EXPORT_TOKEN`,
   `LISTENING_PRIVACY_TOKEN` via the secret manager/secret input, never shell history, config files
   or URLs. Distribute only to named authorized reviewers. Export and privacy credentials are
   separate; the hosted control-plane login grants neither. Do not casually rotate HMAC: preserve
   old suppression and deletion lookup ability with an explicit migration.
5. Verify zone rules: no body logging, query capture, error payload capture or injected analytics for
   listening pages and APIs. `_headers` CSP/no-transform and absent analytics mounts protect pages.
   Check redirects, framing refusal, mobile/zoom/keyboard and live status using the real hostname.
6. Only after those checks set `LISTENING_REVIEWED=community-listening-2026-11-15-v1` and
   `LISTENING_ENABLED=true` in the site deployment configuration. Set up a monitored operational
   queue for privacy and follow-up requests. No automated emails or outreach are part of this work.
7. Deploy through the registered ForgeGraph **educateos-site** app production target, after tests
   and approved merge. Check health evidence and anonymously fetch all three public pages and
   `/api/listening/config`. Confirm unauthorized exports fail. Use synthetic adult test data and
   delete it after proving storage/export. Never claim the feature is live based only on a push,
   merged PR, healthz from another app or a static page rendering. Record exact revision/deployment.

SCHO-430 / canonical PRs #411 and #428 record the scoped launch evidence: independent credentials,
hostname-restricted real widget, keyboard challenge completion, no injected analytics/body logs,
free listening-route edge body/burst controls, and existing enabled capacity budget alerts.
An isolated deployed SQLite rehearsal proved object-restart persistence, idempotency, private
export/erasure, real alarm expiry and actual provider PITR followed by deletion replay. Its
synthetic rows, temporary credential and Workers were removed. Cloudflare's SQLite PITR keeps
30 days of recovery history; it is not erased on demand by deleting an active record.
The production configuration now opts this listening collection in; deployment plus the final
live synthetic submit/export/erase and exact-revision health evidence remain tracked on SCHO-430.

To pause, set `LISTENING_ENABLED=false` and deploy this site target. Submission/config then fail
closed while staff export/erasure remain available. During any recovery, keep collection paused,
replay independently retained verified deletions, remove affected private exports, and verify
expiry/suppression before reopening. Do not restore a production object using the rehearsal.

The old intake README's draft-only authorization applied to SCHO-295. This separately authorized
implementation does not remove its security prerequisites or open that funnel.

## Staff-only export, retention and deletion

Use a secret-aware HTTP client; never place tokens or downloaded PII in URLs, terminal output,
issues, PRs, chat or this repo. Save files mode 0600 on private encrypted storage.

- `GET /api/listening/admin/export?kind=survey` or `kind=contact` with
  `Authorization: Bearer <LISTENING_EXPORT_TOKEN>`. Returns JSON attachment, `no-store`,
  `{schemaVersion:1, source:'community-listening', kind, records:[...]}`. Each page scans at most
  100 records; continue with `cursor=<X-Next-Cursor>` until empty, even when a page has no records.
  Re-export from the beginning per review session: concurrent inserts can sort before a cursor.
  Use `externalId` to deduplicate. No public dashboard; JSON export meets this step's staff review need.
- Survey deletion: respondent saves the 64-hex deletion receipt generated in browser memory and
  shown on successful submission. It is stored only as an HMAC-derived lookup, never in export.
  Staff verifies possession of the code, then posts JSON
  `{kind:'survey', receipt:'<code>', verified:true}` to `/api/listening/admin/privacy` with
  `Authorization: Bearer <LISTENING_PRIVACY_TOKEN>`. This flag is a staff attestation, not proof.
- Contact deletion/withdrawal: verify email control out of band for erasure; no added consent is
  needed to stop contact. Immediately remove the address from staff follow-up lists. Post
  `{kind:'contact', email:'<address>', verified:true}` using the privacy credential after verification.
- Both operations remove active records/indexes/retry fingerprints and retain only a keyed
  suppression tombstone to avoid reintroduction. These endpoints remain usable if collection is
  paused. Erase relevant private export copies too; website deletion does not erase downloaded files.
- Active records and retry fingerprints expire after 90 days; expired rows cannot be exported.
  Hourly alarms drain due TTL entries in bounded batches. Rate counters last <=2 days, challenge
  hashes 330 seconds, bot aggregates seven days. Recovery copies follow the provider's retention;
  document settings and reapply deletions after restoring. Staff exports have the same 90-day
  lifetime and verified-request erasure requirement. Review deletion completion across copies.
- At campaign close, after resolving follow-up/privacy requests, retire private exports and purge
  both listening objects, including suppression markers, through an explicitly reviewed operation.
  Do not remove the shared INTEREST namespace or affect old intake objects.

## Checks

### Isolated provider rehearsal

`rehearsal/wrangler.jsonc` is a separate temporary Worker and SQLite namespace, without any
production bindings or custom-domain routes. Never import its entrypoint into the public Worker.
It accepts only fixed synthetic fixtures, two named objects and seven authenticated commands;
it cannot dispatch arbitrary store actions, export respondent data or restore production objects.
Use a separate random `REHEARSAL_TOKEN` in its own ForgeGraph stage. Its deadline closes commands
automatically. Keep logs disabled and delete the temporary Worker/stage after recording results.

Deploy the reviewed revision through an isolated `educateos-site` stage/target. With the scoped
token held in memory, POST `/rehearsal/recovery/seed`, `/inspect`, `/restart`, then `/inspect` again:
both submissions return 200 and exactly one row survives restart. Obtain `/bookmark`, `/erase`,
verify zero rows, then `/restore` with the bookmark as the short text body. After its deferred
restart, verify the synthetic row returned and suppression did not: recovery copies can undo
deletions. Reapply `/erase` and verify zero rows plus suppression before considering recovery
complete. Keep real collection closed during any production recovery and replay independently
retained, verified deletion requests before reopening; also erase affected private exports.
The rehearsal does not provide a production restore endpoint or claim backup erasure on demand.

For expiry, `/rehearsal/retention/seed` backdates only its synthetic record to five seconds before
the unchanged 90-day TTL; the real storage alarm runs six seconds later. `/inspect` must show
zero stored/exported rows and `alarmDelivered:true`. `/clean` both objects, revoke the rehearsal
credential and retire its stage/Worker. Local `rehearsal/check.mjs` verifies guards/restart/expiry
but cannot prove provider PITR.

```sh
node --test sites/educateos-io/listening/listening.test.mjs sites/educateos-io/intake/*.test.mjs
node sites/educateos-io/build.mjs --check
node --test sites/educateos-io/*.test.mjs
node sites/educateos-io/listening/browser.test.mjs
pnpm exec wrangler deploy -c sites/educateos-io/wrangler.jsonc --dry-run --outdir /tmp/educateos-listening-worker
node sites/educateos-io/listening/runtime-check.mjs /tmp/educateos-listening-worker/worker.js
pnpm lint
```

Existing `site-config.test.mjs` runs listening security tests in the current site CI path.
Tests use fake Cloudflare storage and fake Siteverify, not production secrets or real people.

The browser smoke uses installed Chrome and fixture API/Turnstile responses, with no live server.
The runtime smoke uses the Wrangler-bundled real Worker in Miniflare/workerd and a temporary
on-disk SQLite store. It has no production bindings and removes its synthetic data afterward.
