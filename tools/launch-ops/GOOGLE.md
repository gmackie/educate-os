# Approval-gated Google bridge (v1)

SCHO-302. Draft-only local operator tool, stacked on #19 → #7. No application, website (#17), production worker or Launch Factory changes. Node 22+, built-in fetch, no dependencies. This milestone is published as a **draft PR**, with no live Google testing or external school contact. The mock fixture uses only `.invalid` identities.

## Offline first

```sh
node tools/launch-ops/src/cli.mjs simulate-google
node --test tools/launch-ops/test/*.test.mjs
```

`simulate-google` uses a new private temporary store, real importer/review/domain transitions and a versioned fake HTTP transport. It never falls back to fetch, accepts no operational inputs and removes its store afterwards. Its separately advanced synthetic clock lets the scenario exercise a post-meeting decision. Output audits the complete website-interest v1 quarantine → independently verified staff → council campaign → approved handoff → verified Gmail draft → simulated outside human send → exact SENT reconciliation → redacted reply review → actual seat acceptance → explicit meeting request → availability recheck → internal hold → reviewed notes/actions/feedback disposition. These synthetic counts do not enter your operational store. No real draft, message, event or OAuth call occurs.

The existing website-interest-v1 schema is unchanged. Local `.eml` export still reserves caps/cooldowns and is unsent. Google attaches `<opaque-handoff-uuid@configured-sender-domain>` as RFC2822 Message-ID and the exact handoff approval header. The operator must control that domain. The bridge records opaque Gmail draft/message/thread IDs, not a mailbox permalink or credentials. A draft container stays stable across Gmail edits, while embedded message IDs change; actual sending creates a new SENT message. Saved IDs, exportedAt and drafts.create never prove sending or delivery.

## Manual owner-only bring-up, before any live opt-in

1. Review this draft's safety and mock coverage. Independently authorize the sender, monitored opt-out address, valid postal address, professional identity, explicit request and applicable source/commercial-message policies. Use the existing private sender configuration, caps, cooldowns and suppression. An `.invalid` fixture sender is unsuitable for live use.
2. Configure a Google Cloud project, enable Gmail and Calendar APIs and choose the correct OAuth app/audience configuration. Minimum requested scopes for these operations: `https://www.googleapis.com/auth/gmail.compose`, `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.events`, `https://www.googleapis.com/auth/calendar.events.freebusy`. Gmail compose and readonly are **restricted**; Calendar events and events.freebusy are **sensitive**. External apps require Google's applicable OAuth verification; restricted-scope use can require a security assessment depending on data handling. Owner-only/internal testing is not a claim of exemption, consent, Workspace admin approval, certification or verification. Scope grants may technically permit sending; this adapter exposes no send endpoint.
3. Provision a short-lived access token through a trusted local OAuth tool and set `LAUNCH_OPS_GOOGLE_ACCESS_TOKEN` privately in the calling shell, without shell history/logging. Never paste it into JSON, command arguments, the dashboard, repo, issue or PR. The API also accepts an in-memory secure `accessToken` callback for embedding. No access/refresh token is saved. Expired tokens fail closed; there is no automatic refresh. A future OAuth wizard should use authorization code + PKCE, state, loopback redirect validation and a secure OS credential store if refresh tokens become necessary. None is implemented here.
4. Confirm `users/me/profile` returns the exact configured sender before all mailbox operations and Calendar writes. Send-as aliases are deliberately unsupported. The primary calendar event organizer must match that mailbox on read-back. Token possession alone never grants a school identity privileges in EducateOS.
5. Independently approve the exact content/recipient/source/campaign/sender/suppression hash and an explicit handoff. Then use the flags below to opt into one operation. Network commands are CLI-only; the loopback CSRF-protected dashboard only previews and records local reviews.

No live Google operation was authorized or run while implementing this milestone. Manual OAuth provisioning and owner-only live acceptance testing remain outstanding configuration/review work.

## Exact local preview and execution

All files below belong under `tools/launch-ops/.private/` (gitignored, owner-only). Review fields use `{humanReviewed:true,reviewer:"human name",reviewedHash:"exact preview hash"}`. Do not automatically approve previews in operational scripts. The synthetic simulator's automated reviewer is exclusively for fictional data in an isolated store.

Use `funnel <action> <private.json>` or the dashboard for local actions:

| Action | Input (plus review fields where stated) |
| --- | --- |
| `google.preview` | `{handoffId}` from a previously approved/exported outreach handoff |
| `google.approve` | `{handoffId,messageIdDomainControlled:true,...review}` from that exact preview; returns bridge `id` and `hash` |
| `meeting-request.accept` | `{candidateId,responseId,meetingRequestedConfirmed:true,respondentVerifiedConfirmed:true,expiresAt,note,preview:true}`; remove preview and add review fields to accept |
| `calendar.propose` | `{requestId,slot:{start,end,timeZone},council:"educator" or "technical",agenda:["topic"],operator}`; returns preview with `id,hash` |
| `calendar.preview` | `{id}` for the current proposal |
| `calendar.approve` | `{id,internalNoAttendeesConfirmed:true,...review}` |
| `meeting.review` | `{holdId,meetingOccurredConfirmed:true,notesSanitizedConfirmed:true,notes,actions:[{title,owner,dueAt}],decision:"accepted" or "deferred" or "declined",rationale,followUp,preview:true}`; after the meeting, remove preview and add review fields |

Gmail execution JSON is exactly `{schemaVersion:1,id:"bridge-id",handoffId:"exact-handoff-id",reviewedHash:"bridge-preview-hash"}`. Calendar execution is `{schemaVersion:1,id:"hold-id",reviewedHash:"approved-hold-preview-hash"}`. Read/reconcile JSON is `{schemaVersion:1,id:"bridge-or-hold-id"}`. Unknown execution fields, tokens and attendee fields are refused. Flags cannot be supplied through JSON.

```sh
# Examples are commands for a separately approved future opt-in, never part of tests:
node tools/launch-ops/src/cli.mjs google-draft --allow-network --create-gmail-draft tools/launch-ops/.private/google-execute.json
node tools/launch-ops/src/cli.mjs google-reconcile-draft --allow-network --read-google tools/launch-ops/.private/google-read.json
node tools/launch-ops/src/cli.mjs google-reconcile-sent --allow-network --read-google tools/launch-ops/.private/google-read.json
node tools/launch-ops/src/cli.mjs google-replies --allow-network --read-google tools/launch-ops/.private/google-read.json
node tools/launch-ops/src/cli.mjs calendar-hold --allow-network --create-calendar-hold tools/launch-ops/.private/hold-execute.json
node tools/launch-ops/src/cli.mjs calendar-reconcile --allow-network --read-google tools/launch-ops/.private/hold-read.json
```

Draft creation uses only POST `/gmail/v1/users/me/drafts` with `{message:{raw:base64url-RFC2822}}`, then GET drafts/{id}?format=full. Read-back must match exact Message-ID, approval header, one recipient, sender, subject and plain body. Draft approval is separate from outreach approval. Changing copy, source, sender, campaign or suppression fails closed. Existing cap and cooldown reservations from the exact handoff are reused. Success is idempotent locally, with no repeated POST.

Actual sending remains a separate human Gmail action outside this tool. SENT reconciliation uses `messages.list` with exact `q=rfc822msgid:<id>`, `labelIds=SENT`, bounded results and `threads.get` only for returned known threads. The exact source must have SENT, approved sender/recipient/subject/body, no Cc/Bcc, exact source Message-ID and valid Gmail internalDate after handoff. Altered copies get manual review and no compliant-send count. A caller's imported claim of sending is never used by the adapter. The existing `delivery.record` pathway still requires an independently inspected receipt reference, preview hash and explicit human evidence confirmation; it is an operator attestation, not machine authentication. SENT proves sending, not delivery. Confirmed bounces use the existing human-reviewed `delivery.record` status `bounce` (for a handoff without an existing delivery record) or `candidates.suppress` reason `bounce` after checking the actual bounce; automated bounce classification is deferred.

Replies are read only from a conversation with a verified exact SENT source. Only the expected From/To and a source Message-ID in In-Reply-To/References can enter the review queue. This is conversation matching, **not authentication**: a matching From can be forged, and accepting a meeting requires independent respondent verification. Other participants or unsupported MIME retain only opaque IDs/hash/reason, no headers/body/subject. No unsolicited mail import, broad mailbox query, attachment fetch or LLM mailbox processing exists. Exactly one bounded UTF-8/ASCII text/plain part is supported, including nested multipart; Gmail full-format body.data is base64url of already transfer-decoded MIME content. HTML-only, unsupported encodings, attachments and complex/oversized messages fail closed. The retained top excerpt removes quoted history and conventional signatures, redacts contacts/URLs/phone/credentials/labeled student fields, and stays ambiguous pending exact-hash review. STOP/unsubscribe suppress immediately before review. Heuristic redaction can miss unstructured names/student information: manually sanitize/erase and retain risky bodies outside this tool under approved policy. No positive keyword, signature or incoming suggestion auto-promotes consent.

## Internal Calendar holds and uncertainty

A positive response or role fit alone is insufficient: review its exact scope, independently verify respondent and attest the explicit meeting request, with expiration within 30 days. New unreviewed/negative replies or suppression block scheduling. Holds require separate preview hash approval, future RFC3339 timestamps with explicit offset, valid IANA timezone, matching DST offsets, weekday 09:00–17:00 local times, 15–60 minute duration and start within 90 days. `freeBusy` queries only primary with timeMin/timeMax/timeZone immediately before reserving the insert intent. Busy/error/unknown results stop. Availability is a snapshot, not an atomic booking guarantee.

POST `/calendar/v3/calendars/primary/events?sendUpdates=none` includes a deterministic 67-character base32hex-safe ID, private visibility and internal agenda. **No attendees field is accepted, even an empty caller-supplied array.** Event attendees are absent (therefore empty), with no conferenceData/external invitation. Google warns notifications can occur despite notification controls; sendUpdates=none is not a safeguard if attendees are present. This bridge refuses them entirely. Returned event ID, times, agenda, privacy and organizer must match. The internal hold does not prove acceptance or meeting attendance; a separate human post-meeting review captures sanitized notes, council, agenda, action owners/dates, and feedback decision/rationale/follow-up. Future meetings cannot be marked occurred.

Before every external write the store commits status `uncertain` and attemptedAt. A crash before/during/after HTTP therefore cannot trigger an automatic retry. If creating/read-back fails, the same durable uncertain lock remains. Errors never log tokens or Google response bodies. Successful draft/event retries return the saved record without creating another. Calendar recovery GETs the deterministic event ID; an absent/mismatched event stays uncertain, with no automatic reinsertion.

Gmail recovery lists only drafts matching the stable Message-ID, then fetches the exact match. More than one match or incomplete pagination keeps the lock. No match does **not** prove absence after a race/send/eventual consistency. Inspect Gmail manually, including actual sending, before considering release. To release a draft only, run `google-reconcile-draft`, then local `funnel google.release` with `{id,...review,noDraftInGmailConfirmed:true,duplicateRiskAcknowledged:true}` using the returned hash within ten minutes. This records a fresh human decision before a manual retry of the same handoff/Message-ID. A stale handoff or duplicate state cannot release. Never delete intent records to retry. No automatic stale-lock timeout. A filesystem `transaction.lock` left by a killed process separately needs all tool processes stopped before manual removal; removing it does not release Google uncertainty.

## Security, retention and limits

Only the two fixed HTTPS API hosts are reachable through constructed methods. IDs are opaque allowlisted syntax; no arbitrary URL or send endpoint is exposed. Requests disallow redirects, retry zero times, require JSON 200, cap streamed responses at 1 MB and enforce a 10-second whole-operation deadline, including credentials callback/body. Message MIME/text has tighter bounds. Google errors are generic. The adapter never returns/persists a token, headers or raw API error. Scope grants, local reviewer identity and independent evidence authenticity are external trust boundaries.

Private state remains plaintext under existing 0700/0600 protections. Daily retention queues still apply. Verified `privacy.erase` removes contact-linked Google IDs, quarantine hashes, requests, holds, excerpts and newly linked meeting notes/feedback/actions; keyed suppression survives. It does not delete external Gmail drafts, messages, Calendar holds, OAuth grants, private execution JSON files or backups: inspect/remove those manually under the same policy. Remote deletion/cancellation is intentionally unsupported. Erasure during an outstanding request needs manual remote reconciliation. Existing unlinked free-text notes need manual inspection.

Known limits: single trusted local operator, self-attested authority, heuristic redaction, no cryptographic sender authentication, no automated bounce recognition or OAuth wizard, no broad MIME support or mailbox search, no live vendor acceptance test. Mock fixtures approximate documented API wire formats. Polished dashboard UX is deferred; actual preview/review controls and queues are present, network execution stays CLI-only. No merge or deployment is required or authorized for this draft milestone.

## Official references

- [Gmail drafts, container/message lifecycle and base64URL RFC2822](https://developers.google.com/workspace/gmail/api/guides/drafts)
- [Get profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [List drafts (q)](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/list)
- [List messages (q and labelIds)](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Restricted Gmail scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Calendar freeBusy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Calendar events.insert, ID alphabet and notification caveats](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Validation for this draft

Node 22: **56/56 tests passed** (original 38 plus 18 adversarial Google tests), all 28 JavaScript source/test files passed syntax checks, and scoped Oxlint 1.90.0 returned exit 0. CLI `help` and `simulate-google` are covered by the suite. Repository-wide `pnpm lint` was attempted but could not start: pnpm's workspace dependency check failed opening its shared-store SQLite database (`ERR_SQLITE_ERROR: unable to open database file`). No root dependencies/configuration were modified to work around it. No live Google acceptance test, real school contact, send, merge or deployment was run.
