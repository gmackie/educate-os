# EducateOS Foundation Launch Operations

A runnable **local operator tool** for sourced institutional contacts, approved unsent drafts, staff interest, advisory councils and synthetic pilot planning. Node 22+, no runtime dependencies, no install required. It is independent of `tools/launch-factory`, the Workshop, and production services. It contains no email sender, direct Gmail/Calendar connector, deployment, or external-ticket action. Public-site intake is a separate feature; this branch imports authenticated downloads only.

## Run

From the repository root:

```sh
node tools/launch-ops/src/cli.mjs demo  # optional: four fictional .invalid contacts; safe to repeat
node tools/launch-ops/src/cli.mjs serve # 127.0.0.1:4318; optional --port 4319
```

Open the full URL printed by the CLI, including the session fragment. Treat it as a secret. It is removed from the address bar after loading and kept only in page memory. Reloading requires reopening the printed URL. Stop with Ctrl+C. Do not expose the port through a proxy or tunnel.

```sh
node --test tools/launch-ops/test/*.test.mjs
# Equivalent package command, if pnpm is already available:
pnpm --dir tools/launch-ops test
```

The tool is intentionally outside the pnpm workspace: running it does not install or build the application. Its isolated GitHub/Forgejo workflows tests Node 22 and 24 without dependencies.

## Sourcing → approved draft → explicit interest

Stacked on PR #7 / SCHO-287; tracked by SCHO-289. No website changes, merge or deployment. Requires Node 22+, no runtime dependencies or application build. Architecture and threat boundaries: [ARCHITECTURE.md](ARCHITECTURE.md). The new dashboard tabs share the original private store and council/meeting/pilot gates.

```sh
node tools/launch-ops/src/cli.mjs sources
node tools/launch-ops/src/cli.mjs registry-import tools/launch-ops/examples/registry.json
node tools/launch-ops/src/cli.mjs funnel sender.configure tools/launch-ops/examples/operator.json
node tools/launch-ops/src/cli.mjs serve
```

The example sender/address is **fictional and unsuitable for actual commercial handoff**. Replace it in a private copy with an authorized identity, valid physical postal address, monitored free opt-out mailbox, caps and a human compliance review. Keep every operational import/config under `.private/` (gitignored), protect the device, and do not commit PII. Never expose the dashboard via a proxy/tunnel.

1. **Sources & quarantine:** review the registry import provenance, approve its exact official origin and hash. The source manifest at [config/sources.json](config/sources.json) includes the operator-provided NCES 2024–25 LEA/CCD, 2023–24 PSS, AskTED, MI School Data/nonpublic, REMC RITS, Texas ESC, CoSN chapters and TCEA sources, plus FTC guidance. These URLs were supplied by the operator and were not fetched in this implementation. Organizations are seeds, never implied interest or endorsement; associations are referral/partnership channels, never permission to harvest members.
2. Import explicit staff candidate JSON via `candidate-import <private.json>` or the dashboard. Required top-level fields: `organizationId`, `operator`, `noStudentData:true`, `records`. Each record has `name,email,role,sourceUrl,observedAt` (ISO UTC), `snippet` explicitly containing all three identity fields, and `evidenceHash` (64 hex SHA-256). Public email must match the approved institutional domain. All records start **discovered**, outside the usable contacts list. For the robust structured official-site adapter, use `official-fixture <private.json>` with `organizationId,url,observedAt,operator,robotsTxt,html`; copy the supplied fictional HTML/robots fixture text and the organization's actual local UUID. Only explicit schema.org Person records with matching `worksFor.name` are extracted; no addresses are guessed.
3. Read exact provenance/hash in the dashboard and personally verify published staff identity, title and address. Then select one initial contact for that organization. The deterministic persona is public **role fit**, never purchase intent or expressed interest. Freshness limit: 90 days. NCES IDs preserve leading zeros; ID, domain or normalized organization name/state dedupes registry imports. Contacts dedupe by address or name/organization without silently overwriting verified evidence.
4. **Campaigns & exports:** create the appropriate campaign (regional referral, discovery interview, council, technical demo or opt-in webinar), draft for a selected person, inspect and optionally edit it, then explicitly approve its current hash. Recipient, subject/body, campaign revision, sender/config, organization, source imports and verified evidence all bind approval. Any edits, paused campaign, suppression, stale evidence or changed recipient block handoff. Templates say **“we are exploring a foundation model”** and **“open source and district-owned design”**; no incorporated/501(c)(3) foundation, signed Clever contract, certification, participating districts, production pilots, outcomes or endorsements are established. Human claim review remains required; a keyword guard is not legal or fact verification.
5. Export one approved **EML** (`X-Unsent: 1`, MIME/base64 text and encoded headers), or approved CSV/JSON, under `.private/exports/`. This is a draft handoff, never sending. EML is single-message; explicit human batch approval is available through JSON (`outreach.approve`), never daily automation. Export consumes the conservative daily capacity budget (1–20/day), reserves that organization, and starts a 14+ day cooldown. One initial person per organization across campaigns, at most one follow-up to that same person/campaign after the configured wait, and any imported reply stops follow-up. Re-export is refused. A human must independently manage any outside mail client; this tool cannot revoke copied drafts.
6. **Staff interest & replies:** import a website download with `interest-import <private-export.json> <operator>` or the dashboard. Contract: [schemas/website-interest-v1.schema.json](schemas/website-interest-v1.schema.json); example: [examples/website-interest.json](examples/website-interest.json). Every record quarantines even if an external `verificationStatus` says verified. Verify staff/email/organization outside the tool and match the registry before promotion. The synthetic local form accepts `.invalid` addresses only, displays the privacy notice, and separates one-time response consent from optional unchecked marketing consent. No Turnstile, public endpoint, webhook or external form publishing is added here.
7. For replies use `responses-import <private.json>` with `operator,records` or `operator,csv`. Exact columns/fields: `externalId,candidateId,receivedAt,text,state,sourceUrl`; suggested state is one of `interested,needs-info,declined,unsubscribed,ambiguous`. Only narrow unambiguous unsubscribe text blocks immediately. Every other reply begins ambiguous, regardless of imported suggestion, until human hash review specifies its state and expressly requested scope. Declines/bounces/opt-outs suppress; ambiguous language never changes consent. Text must be staff-only and omit student records, credentials, URLs and third-party contact information.
8. Review an explicit request and route it to demo, interview, feedback, technical review, council or pilot. **Council interest does not assign a seat:** actual acceptance is separately attested. Pilot interest creates only a synthetic planning record; all eight foundation gates and district-owner authorization remain mandatory. Feedback can attach to the existing meeting workflow, with decisions/rationale/follow-up.

### Inbound contract and consent

The website agent uses `{schemaVersion:1,source:"website-interest",records:[...]}` with stable event IDs. Strict fields: `externalId,receivedAt,name,workEmail,org,state,role,interestType,marketingOptIn,verificationStatus,consentVersion,limitedFeedback,referralSource,responseConsent,staffConfirmed,privacyAcknowledged`. State is MI/TX/other; interest types are demo/council/technical-review/pilot/feedback/webinar/unsubscribe/deletion. Feedback is <=1500 characters; timestamps cannot be future; referral is a first-party landing label, not a URL. Unknown/student fields and credential text are rejected. All flags must be explicit booleans.

Minimal unsubscribe/deletion events may have empty name/org/role and false consent flags: no extra identifying information or consent is required to suppress an address. An unchecked marketing box alone is **not** an unsubscribe. Exact event reimports are idempotent; changed IDs fail except privacy actions, which still block immediately. Use a new event ID for scope changes. Verified consent is immutable per event and scope-specific; new events do not overwrite old permission. Existing-person identity/consent reconciliation is deliberately held for manual review rather than silently promoting a conflicting request. Website unsubscribe is separate from verified erasure. The website branch remains independent and uses manual authenticated export, never a webhook to a laptop.

### Daily operation, metrics and retention

`daily <private.json>` requires `operator,approvedLocalSources:true`; optional `registry:[...]`, `discoveries:[...]` ingest approved local batches. Optional `prepareSelected:true,campaignId` drafts only people **already explicitly selected**. The daily workflow is idempotent for unchanged source/evidence/state on that UTC day. It creates review queues, never selection, approval, export, contact, consent or membership.

`metrics` and the dashboard show distinct organizations/contacts separately; approved/exported drafts are not sent messages. Response rate is **unknown** without actual external send evidence. Optional `delivery.record` accepts a handoff ID, UTC time, sent/delivered/bounce status and independent receipt reference, first previewed and hash-reviewed by a human. Only independently confirmed sends form the invitation denominator; replies attribute to the latest preceding confirmed invitation for that contact. Source cohorts can overlap after dedupe and must not be summed. Expressed interest requires reviewed explicit opt-in/request; role matching and imported rows do not count. Pilot planning, gate readiness and authorization are separate signals.

Default retention review: 90 days (configurable 7–365); daily lists expired candidates. Use **Review personal-data erasure** in Sources & quarantine, or `funnel privacy.erase <private.json>` with `address,preview:true`, then exact human hash plus `deletionAuthorityConfirmed:true`. It removes linked personal/contact/draft/reply/interest/council/pilot records, retains keyed HMAC suppression and import receipts, and purges **all** local exports conservatively (including unrelated draft exports). It does not automatically erase on unverified deletion import. Remove independently copied exports, private input files and backups manually; free-text meeting notes need manual inspection. Keep the private suppression key/records under the same protected ownership; a full directory reset loses suppression. No automatic reactivation path exists.

### Optional network discovery (never run by CI or this change)

Offline official HTML snapshots/CSV are the primary reproducible path. Only after separately reviewing a real institution/domain and source terms may an operator use:

```sh
node tools/launch-ops/src/cli.mjs crawl --allow-network tools/launch-ops/.private/crawl.json
# crawl.json: {"organizationId":"local-uuid","urls":["https://approved-school-domain.invalid/staff"],"operator":"reviewer"}
```

The example is fictional and not a network target. No auth, login, member, social or student pages; no LinkedIn scraping. Domain review expires after 30 days. Exact HTTPS origin/443 only, no credentials/query/fragment, no redirects, validated DNS **pinned to the actual TLS connection** with original hostname/SNI and certificate verification, all DNS answers public IPv4 (IPv6 intentionally unsupported), no connection pooling, 5-second DNS/10-second request deadlines, content-type checks and 256 KB response cap. Robots must return plain text 200; missing/failed/unsupported robots stops. Applicable deny rules, longest allows, wildcards and crawl-delay are honored conservatively; 1+ second between requests, at most 3 chosen staff pages/run and 6 reserved requests/domain/UTC day including robots and failures. The dashboard cannot invoke networking. This adapter is narrow, not a general staff scraper; unsupported pages require approved local fixtures and human verification.

### Checks and known limits

```sh
node --test tools/launch-ops/test/*.test.mjs
pnpm --config.store-dir=/private/tmp/educateos-interest-pnpm --config.cache-dir=/private/tmp/educateos-interest-cache dlx oxlint@1.90.0 --deny-warnings tools/launch-ops/src tools/launch-ops/web/app.js tools/launch-ops/test
```

38 tests pass on Node 22, including a real loopback HTTP end-to-end workflow, approval/cap/consent/suppression/deletion threats, and mocked DNS-pinning/robots/crawler transport. Existing foundation tests remain intact. No live discovery or network smoke test was run. Scoped Oxlint passes. Workspace `pnpm lint` was attempted but could not start because this checkout has no dependencies and pnpm's protected shared-store project symlink returns EPERM; repository-wide tooling is unchanged. Isolated Node 22/24 CI runs syntax, scoped lint and offline tests without building production packages.

Single trusted local operator; plaintext state, self-attested authority and heuristic sensitive-text guards are unchanged limits. Hashes detect stale content, not a malicious filesystem owner. Human/legal/source review is essential. Browser interaction/accessibility needs human review. Export creation and state commit are separate filesystem operations: an interrupted export may need manual reconciliation. Gmail/Calendar connectors, remote scheduling, real delivery verification, broad page adapters and multi-user authentication are future work. No actual outreach, public intake publishing, paid API call, merge or deployment occurred.

## Workflows

- **Councils & contacts:** eight educator seats and six technical seats, with distinct seat labels. Import a manually prepared CSV after verifying public professional addresses, source URLs and role tags. This legacy manually verified import does no fetching. The sourcing pipeline below provides a separate quarantine boundary and opt-in official-site adapter. Dedupe uses lowercase email or normalized name + organization; duplicates do not overwrite reviewed metadata. Seat assignments require recorded acceptance, not an inferred response.
- **Role fit:** ten points per matching, allowlisted professional role tag for that council, with visible reasons. There is no purchase-intent, budget, sensitive-trait, or behavioral scoring. Tags are operator-reviewed source assertions; the score is not an independent verification or seat-specific recommendation.
- **Invitations:** deterministic personalized drafts use public name, role, organization and source. Default language describes EducateOS as open source with its core running in the organization's Cloudflare account. It seeks advice, promises no outcomes or compensation, and claims no district approval, certification, or existing partnership. Human edits require a new review. Review exact text, recipient, source, council and provenance; confirm truthful claims and record your name. SHA-256 binds approval to that content. Export approved drafts as local JSON or spreadsheet-safe CSV. Recipient changes, edits, provenance changes or suppression block stale approval. Export is never a send.
- **Meetings:** dated agendas with facilitator/time allocation; actions with owners, due dates and completion evidence; feedback with accepted/deferred/declined disposition, rationale and follow-up reference.
- **Pilot gates:** create an exact synthetic scope and accountable owner. Upload sanitized textual evidence with a title and document/version reference, then read it and record an authorized human gate decision, rationale and expiration. All eight gates below are mandatory. Only then can an authorized district owner review the combined scope/gate hash and record final authorization. Export revalidates evidence hashes, decisions and expiration. A scope/owner revision clears every gate; adding evidence clears that gate and final authorization. Revocation blocks export. This records planning authorization; it neither grants access nor starts a pilot.
- **Support:** explicit categories route to local privacy, security, accessibility, technical, training or operations queues. Privacy/security are urgent. Common secrets, URLs, emails, numbers and labeled student fields are redacted before persistence. Manually remove any missed names or identifiers, then approve the exact redacted content hash before export. Resolution text is redacted and requires a new review. No external ticket is created.

### Contact CSV

Exact headers (order may vary):

```csv
name,email,organization,role,sourceUrl,tags
Avery Example,avery@cedar-example.invalid,Cedar Example District,Fictional curriculum lead,https://cedar-example.invalid/staff/avery,teaching|curriculum|training
```

Only fictional examples are shipped. For operational imports, verify an organizational email and a publicly available HTTPS source without credentials, query or fragment. Personal mailbox domains are rejected as a conservative heuristic, not proof of professional status. Limits: 500 rows / 200 KB. Quoted commas, escaped quotes, and multiline cells are supported. Unknown tags and malformed headers/rows are rejected. Allowed tags:

`teaching`, `curriculum`, `special-education`, `accessibility`, `leadership`, `district-operations`, `training`, `community`, `security`, `privacy`, `cloud`, `integrations`, `testing`.

### Required pilot evidence

| Gate | What the authorized human must verify |
| --- | --- |
| `districtAgreement` | District-approved agreement, exact pilot scope/dates, and authorized signatory reference |
| `dpa` | Executed DPA covering the scope, responsibilities, retention and deletion |
| `security` | Reviewed security assessment, controls and disposition of findings |
| `technical` | District technical owner review of account, identity, network/integration and rollback readiness |
| `accessibility` | Accessibility review including keyboard/assistive-technology evidence and accommodations |
| `syntheticTests` | Dated, repeatable synthetic test results for the proposed scope and environment |
| `training` | Training completion/materials and support/escalation readiness |
| `owner` | Named accountable district owner and documented authority for the scope |

Store sanitized excerpts and references, never student records, credentials or signature images. Each gate's evidence belongs to that exact pilot/gate. An unrelated URL or a checkbox alone is insufficient: the operator must inspect the actual evidence. The prototype can verify bytes and review state, **not** document authenticity, legal adequacy, or reviewer authority.

## Private state and security boundary

All operational records, evidence text, approvals, audit events and exports stay under `tools/launch-ops/.private/`, excluded by this directory's `.gitignore`. There is no configurable output path or HTTP filesystem reader. Directories use mode 0700, files 0600, exclusive transaction locks, atomic state replacement, and symlink checks. Exports have generated UUID filenames under `.private/exports/`; spreadsheet formulas are prefixed with an apostrophe. Browser rendering uses text nodes, not HTML interpolation. The server binds IPv4 loopback, checks Host/Origin, requires a random per-process API token, provides no CORS, uses no-store responses, and sets a restrictive CSP. Logs exclude operational content.

**Prototype limits:** single trusted local operator, not a multi-user or production service. Names and authority are self-attested; possession of the local token permits recording reviews. A local process or filesystem owner can alter state, recompute hashes, or call the API. Hashes detect stale content, not malicious disk tampering. Audit events are local records, not a signed or tamper-proof ledger. State is plaintext, not encrypted. Redaction and sensitive-data detection are heuristics and can miss unstructured personal information; manual review is mandatory. No claim of FERPA/COPPA compliance, certification, district readiness or legal authorization is made.

Before operational use, obtain district/privacy/security approval for this workflow, use a protected encrypted device, verify evidence and authority outside this tool, set retention/deletion policy, and arrange controlled backup/recovery. Never enter real student information. For personal-record deletion use the pipeline erasure review below; it retains suppression. Deleting the entire `.private/` directory destroys suppression and dedupe receipts, so never use that as an operational retention workflow. Handle independent backups/export copies under the same retention policy. If a crash leaves `transaction.lock`, confirm all tool processes stopped before removing just that stale lock. Transactions are single-process synchronous operations; no high-availability guarantees are made.

## Optional LLM suggestions (disabled by default)

The dashboard and default CLI workflows never call a model. Model requests use an explicit CLI command requiring **both** consent flags (the separate official-site crawler has its own network opt-in):

```sh
# Configure these in your local shell; do not commit or print a real API key.
export LAUNCH_OPS_LLM_URL=https://your-provider.example/v1/chat/completions
export LAUNCH_OPS_LLM_MODEL=your-model
# Set LAUNCH_OPS_LLM_KEY privately in your shell.
node tools/launch-ops/src/cli.mjs suggest --allow-network --allow-expense educator teaching,training
```

This makes one OpenAI-compatible HTTPS request with a 15-second timeout, no redirects, no retries, no tools, and a 400-output-token request limit (provider billing enforcement is external). It transmits only the council and allowlisted tags, never private state, contacts, emails, evidence, support text or arbitrary prompts. A configured endpoint/key alone cannot enable network calls. Output is an **untrusted suggestion** printed to the terminal, never an approved invitation or an automatic state change. A human may adapt it in the draft editor, verify every claim and approve the resulting content. This does not establish provider contractual suitability; review provider terms before opting in.

## Validation

The repeatable suite covers council capacity and acceptance, sourced imports/dedupe, deterministic fit scoring, CSV parsing/formulas, injection treated as inert data, exact-hash human approvals and bypass attempts, stale recipient/content/provenance/suppression, agendas/actions/feedback, all eight pilot gates, cross-pilot evidence, evidence/scope/owner changes and expiration, support redaction/re-review, private permissions/locking/rollback/symlinks, real local HTTP requests, Host/Origin/session checks, malformed/oversized requests, path containment, and mocked opt-in LLM requests. No real contacts, student information, model calls, email actions or deployment occur in tests. Browser interaction/accessibility and legal/process readiness still need human review.
