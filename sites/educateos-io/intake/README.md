# Public interest and feedback intake (SCHO-295)

**Draft only. No merge, deploy, public collection, outreach or marketing sends are authorized.**
All code lives in the independent public site. There are no district, CRM, campaign or mail
bindings. Gmacko Ventures LLC currently operates the project. We are exploring a foundation
model; a foundation is not represented as incorporated, tax-exempt or a signed Clever partner.
“Foundation-owned” here describes the intended separate project intake boundary, not legal status.

## Closed by default

`INTEREST_ENABLED=false`, `INTEREST_OPTOUT_ENABLED=false`; no review attestation, site key or
secrets are shipped. `/interest/`, `/advisory/`, `/feedback/` explain the proposed use and stay
closed; no Turnstile code loads until the configuration endpoint is ready. `/api/interest*`
returns 503 without the necessary configuration. Existing site/control-plane paths pass through.
The `InterestIntake` SQLite Durable Object namespace is independent of `ControlPlane`; the
existing Worker name, class name, migration and bindings are preserved. No generated configs,
district packages, launch-ops or launch-factory code changes are needed.

## Setup and rollout gates (future, separately authorized)

1. Review claims, the public intake notice, 90-day retention, data processor terms, international
   transfers, legal controller identity, subject-request procedure and staff-only purpose. Get
   security/privacy review of the code and the manual export/import boundary. No certifications
   or legal compliance guarantee is made by this implementation.
2. In an isolated nonproduction account, validate the new DO binding/migration, alarm delivery,
   transaction semantics, deletion, expired-record exclusion, backup/PITR purge and token replay
   with workerd and a real test Turnstile widget. The offline suite uses a fake Cloudflare
   namespace and transactional storage; it does not prove deployed Cloudflare configuration.
3. Create a hostname-restricted Turnstile widget for **educateos.io**, action **interest**. Configure
   `INTEREST_TURNSTILE_SITE_KEY` (public var) and `INTEREST_TURNSTILE_SECRET` (secret). Test keys
   (`1x…`, `2x…`, `3x…`) are refused by the production configuration guard. Siteverify success,
   exact hostname/action, bounded token, challenge time <=300 seconds and replay checks are
   mandatory. Siteverify uses only its fixed HTTPS URL, a 5-second timeout and no redirects.
4. Set independent random secrets of >=32 characters: `INTEREST_HMAC_SECRET`,
   `INTEREST_EXPORT_TOKEN` and `INTEREST_PRIVACY_TOKEN`. Do not reuse values. Use Wrangler's secret
   input or a secret manager, never config files, terminal history or URLs. Do not rotate the
   HMAC secret casually: it namespaces durable suppression and idempotency. Preserve old
   suppression during any planned rekey migration. Export token grants downloads only; privacy
   token grants verified suppression/erasure only. Neither accepts the control-plane session or
   a user-provided Access email header. Distribute credentials to named authorized reviewers via
   the organization secret manager; review/revoke access regularly and after any incident.
5. Set `INTEREST_REVIEWED=website-interest-2026-10-30-v1` only after those reviews and deployed
   retention/export tests. Set `INTEREST_ENABLED=true` for separately approved public collection.
   Zone WAF/body-size limits and capacity alerts are required before exposure: application limits
   cannot prevent all Worker/DO billing abuse or IP rotation. Keep Cloudflare request-body logging,
   Logpush URL/query recording and error payload capture disabled for these routes. No raw IP,
   address, challenge or form data is emitted by application logs or public JSON.
6. Before any future commercial email: independently set `INTEREST_OPTOUT_ENABLED=true`, verify
   the email-only `/unsubscribe/` flow without Turnstile or intake credentials, and assign an
   operator for replies to hello@educateos.io. Preserve this opt-out flag, HMAC secret, binding and
   review attestation if interest collection is later paused. Online suppression is immediate in
   this store; carry it into every private sending system before any send. Accept email-reply
   opt-outs without additional identifiers; honor them within 10 business days, preferably
   immediately. There is no sender in this feature. Do not send until the offline suppression
   synchronization, reply process and nonfunctional retention controls below have been reviewed.
7. Manually check keyboard, screen-reader announcements, native validation focus, Turnstile
   keyboard behavior, zoom and mobile layout. Controls have explicit labels and bounds, an error
   summary with focus, live status, a skip link and an unchecked optional updates checkbox.

The generated `/demo/` source is outside this task's permitted paths. A later owner can add
`/feedback/?source=demo#request` there. Teachers/schools/leaders already link using stable
`teachers`/`district` labels. No URL, campaign identifier or browsing history is stored.

## Storage, abuse and privacy

* JSON-only interest POST, <=8192 streamed bytes, strict known fields, exact same-origin header,
  a custom request header and same-origin Fetch Metadata prevent simple-form/cross-site CSRF.
  No cookies or ambient admin authority are used. Static page CSP blocks third-party analytics.
* Name <=120, email <=254, org <=160; roles/personas are an enum. Optional raw feedback <=1000,
  LMS/SSO product names <=120 and fixed blocker/council choices produce <=1500 characters in
  `limitedFeedback`. Reject markup, control characters, URLs and obvious student/credential
  content. No user input becomes a fetch target or HTML. This is **not** comprehensive DLP:
  novel sensitive information can evade pattern detection. Operators must redact/delete accidental
  disclosures; no real student records may be entered in tests or collection.
* Before Siteverify: <=10 attempts/IP/10 minutes, <=1000 global/10 minutes. After Siteverify:
  <=3 ordinary records/address/day, <=10 privacy requests/address/day and <=500 records/day.
  Honeypot hits receive generic success and a 7-day aggregate hold counter, with no bot PII.
  All accepted contacts remain quarantined/unverified, including spoofed plausible organizations.
  No role or email domain proves organizational authority. All legitimate-looking spam still
  requires manual review. Rate-limit failures return 429; generic failures never echo PII.
* Opt-out uses only an email, no challenge/consent fields, supports plain HTML with JavaScript
  disabled and has a separate abuse budget (100/IP and 2000 total per 10 minutes). That keeps a
  normal intake budget exhaustion from blocking opt-out. Budget exhaustion still requires a
  reply/email fallback. Pending unsubscribe/deletion requests immediately write a sticky keyed
  suppression tombstone; they do not falsely establish address ownership.
* Durable transactions atomically store stable opaque IDs, normalized payload HMAC fingerprints,
  per-address idempotency and challenge replay hashes. Retries need a fresh Turnstile challenge;
  the same request key/payload returns 200, a changed duplicate 409. No new row is created by
  a replayed challenge. Idempotency lasts for the 90-day record retention period. Bot/spam holds
  retain no raw data. Raw IP addresses and challenge tokens are never persisted.
* Records, address indexes and duplicate fingerprints expire after 90 days; rate and challenge
  counters expire earlier. Alarms purge in bounded batches hourly (initial alarm within one
  minute). Exports exclude expired records even if alarms are delayed. Sticky HMAC suppression
  tombstones intentionally survive record deletion and do not auto-expire; keyed identifiers
  remain pseudonymous personal information, not anonymous data. Restricted operators periodically
  review their continuing necessity. Cloudflare access is a separate account-level capability.
* Before rollout, establish actual Cloudflare backup/PITR retention, recovery deletion replay and
  export destruction procedures. This code cannot erase already downloaded files or provider
  backups. Private downloaded contact files must be access restricted, kept out of source
  control/sync folders and purged within the same 90-day deadline. Reapply tombstones after any
  restore before reopening intake or review/export.

## Manual export and local import

A named reviewer downloads **only over HTTPS**, with the export bearer token in the
`Authorization` header, `GET https://educateos.io/api/interest/admin/export`. Do not put credentials
in a URL or paste downloaded PII into an issue, PR or chat. Supply headers through a secret-aware
client. Store downloads mode 0600 on an encrypted private disk outside this repository. Responses
are attachments with `Cache-Control: no-store`. No automatic export, webhook, contact creation
in the local CRM or send occurs.

Each response is **strictly** `{schemaVersion:1, source:'website-interest', records:[...]}`.
Pages contain at most 100 scanned rows. If `X-Next-Cursor` is nonempty, request
`/api/interest/admin/export?cursor=<opaque-cursor>` until empty, including when a page exports
zero records (suppressed/expired rows can fill the scan). Download a complete set for a review
session and re-export from the beginning next time; concurrent insertions can sort before a
cursor. Local source+externalId deduplication makes complete repeat downloads safe. Do not
change previously exported records; consent changes are new events and suppression is sticky.

Record fields, agreed with SCHO-289's separate ops agent:

| Field | Meaning |
| --- | --- |
| externalId | Stable opaque UUID, <=120 |
| receivedAt | Server-stamped ISO UTC |
| name / workEmail / org | Plain professional data, limits 120/254/160 |
| state | MI, TX, other |
| role | Self-reported persona; <=160, never verified from a claim |
| interestType | demo, council, technical-review, pilot, feedback, webinar, unsubscribe, deletion |
| marketingOptIn | Explicit optional boolean, default false; false alone is not opt-out |
| verificationStatus | Always unverified on website export |
| consentVersion | website-interest-2026-10-30-v1 |
| limitedFeedback | Optional bounded plain text; council type, blocker and optional product names precede feedback |
| referralSource | Fixed interest/advisory/feedback/demo/teachers/district/unsubscribe label |
| responseConsent | Explicit permission about this specific request |
| staffConfirmed | Self-declared adult professional; never proof of authority |
| privacyAcknowledged | Explicit notice acknowledgment |

Email-only unsubscribe records deliberately use empty name/org/role, state other, empty feedback
and false consent/staff/acknowledgment flags; no extra identifying information or consent is
required to stop updates. The importer must accept this privacy-action exception. Import all
records into quarantine regardless of verificationStatus. Require private operator hash review,
independent verification and explicit consent evidence; never infer permission from source,
professional role, organization or a download. `interest-import <private-json> <operator>` is
owned by the other branch, not this site. Privacy actions create sticky local HMAC suppression
even on duplicate import; changed ordinary duplicates must be rejected. No automated sends.

For a verified subject request, use the separate privacy bearer token with JSON POST to
`/api/interest/admin/privacy`: `{workEmail, action:'deletion'|'unsubscribe', verified:true}`.
This flag is an **operator attestation**, not automated proof. Confirm ownership out of band
before deletion. First import the privacy event into every private review/sending tool and verify
suppression there. Then delete all matching local files/records and invoke website erasure.
That erases contact rows, address indexes and idempotency fingerprints while preserving the
keyed suppression marker. An unsubscribe needs no ownership verification: public email-only
submission suppresses immediately, without deleting records. Treat requests as a separate
operational queue, never a reason to send marketing.

## Offline checks (Node 22)

```sh
node --test sites/educateos-io/intake/*.test.mjs sites/educateos-io/links.test.mjs
node sites/educateos-io/build.mjs --check
# With normal workspace dependencies installed:
node --experimental-strip-types --test sites/educateos-io/site-config.test.mjs
pnpm lint
```

Tests fake Siteverify, Cloudflare namespace/service and transactional durable storage. They cover
closed defaults, missing bindings/secrets, wrong hostname/action, 300-second validity, timeout,
replay, CSRF, 200/400/429, raced duplicates/restart, spoofed claims, XSS/URLs, PII leakage,
spam hold, consent separation, scoped export auth, privacy actions, tombstone survival and expiry.
