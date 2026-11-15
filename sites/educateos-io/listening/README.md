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

The current user authorizes implementation and a PR; **do not merge without user confirmation**.
Collection remains closed (`LISTENING_ENABLED=false`) in committed config. Do not copy the old
interest review attestation or enable its unrelated funnel. These deployment prerequisites remain:

1. Confirm the operator identity/contact mailbox is current and monitored. Review notice,
   processor/international processing terms, 90-day retention, deletion procedure, staff access and
   backup/PITR handling. This implementation does not assert legal compliance or review completion.
2. In an isolated Cloudflare test deployment, prove real SQLite DO persistence after object restart,
   retention alarm delivery, transaction/idempotency behavior, private exports and erasure.
   Fake-runtime tests exercise the real application adapter but do not prove Cloudflare configuration.
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

```sh
node --test sites/educateos-io/listening/listening.test.mjs sites/educateos-io/intake/*.test.mjs
node sites/educateos-io/build.mjs --check
node --test sites/educateos-io/*.test.mjs
pnpm lint
```

Existing `site-config.test.mjs` runs listening security tests in the current site CI path.
Tests use fake Cloudflare storage and fake Siteverify, not production secrets or real people.
