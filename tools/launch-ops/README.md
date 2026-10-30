# EducateOS Foundation Launch Operations

A runnable **local prototype** for advisory councils and launch planning. Node 22+, no runtime dependencies, no install required. It is independent of `tools/launch-factory`, the Workshop, and production services. It contains no email sender, CRM connector, deployment, school-contact, or external-ticket action.

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

## Workflows

- **Councils & contacts:** eight educator seats and six technical seats, with distinct seat labels. Import a manually prepared CSV after verifying public professional addresses, source URLs and role tags. No scraping or source fetching occurs. Dedupe uses lowercase email or normalized name + organization; duplicates do not overwrite reviewed metadata. Seat assignments require recorded acceptance, not an inferred response.
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

Before operational use, obtain district/privacy/security approval for this workflow, use a protected encrypted device, verify evidence and authority outside this tool, set retention/deletion policy, and arrange controlled backup/recovery. Never enter real student information. To remove local data, stop the tool and delete `.private/`; handle any backups/export copies under the same retention policy. If a crash leaves `transaction.lock`, confirm all tool processes stopped before removing just that stale lock. Transactions are single-process synchronous operations; no high-availability guarantees are made.

## Optional LLM suggestions (disabled by default)

The dashboard and default CLI workflows never call a model. The only external request path is an explicit CLI command requiring **both** consent flags:

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
