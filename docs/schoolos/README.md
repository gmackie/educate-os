# SchoolOS

SchoolOS turns this Workshop into a district-owned K-12 learning environment. A district installs it
into its own Cloudflare account. Students, teachers and administrators then work inside it without
operating developer infrastructure themselves.

SchoolOS is open source (Apache-2.0) and is not a hosted service. Every organization that installs it
runs all of it in its own account ([ADR-0011](adr/0011-open-source-charter-and-module-ownership.md)).

This directory holds the decisions and contracts SchoolOS is built on. The execution roadmap (PR IDs
such as F01 and A02) lives in the SchoolOS Kanbanger project, which uses the `SCHO-` issue prefix.

## Where things live

| Path | What it is |
| --- | --- |
| `docs/schoolos/adr/` | Architecture decision records. Read these before changing a SchoolOS boundary. |
| `docs/schoolos/threat-model.md` | Assets, trust boundaries and threats, mapped to the acceptance tests. |
| `docs/schoolos/licensing.md` | The repository license, SchoolOS additions, extracted PlayTrek code, and the rules for ClassBack and vendored code. |
| `docs/schoolos/maturity.md` | How far each capability has got, from designed to certified, with the evidence. Read it before claiming support for a standard. |
| `docs/schoolos/runbooks/` | Procedures a person runs against a live test account: [Access `sub` stability](runbooks/access-sub-stability.md) (SCHO-37) and [installer sandbox verification](runbooks/installer-sandbox-verification.md) (SCHO-66). |
| `docs/schoolos/legal/`, `integrations/`, `spikes/` | Work gated outside the repository: the [standards counsel brief](legal/standards-licensing-counsel-brief.md) (SCHO-62), [Google Classroom](integrations/google-classroom.md) (SCHO-77), the [Cloudflare sandbox spike](spikes/assessment-sandbox-cloudflare.md) (SCHO-102), and [installer OAuth](installer-oauth.md) (SCHO-67). |
| `docs/schoolos/hall-monitor/` | Hall Monitor moderation and AI cost governance: the reconciled plan, model ingress matrix and source specification. |
| `packages/schoolos-contracts` | `@schoolos/contracts`: the shared vocabulary every SchoolOS package imports. Prefixed IDs for every record kind (directory, registry, artifacts, fleet instances), timestamps and opaque codes, scopes, principals with their lifecycle status and source links, verified identities, the authorization vocabulary with `Caller` and principal facts, sources of record (`Authority`, `GradeAuthority`), the audit event base, artifact types and revision references, integration sync runs, roster projections, capability manifests, configuration revisions, policy floors, errors and directory integrity checks. A type a second package needs belongs here, not in a copy. |
| `packages/schoolos-contracts` | `@schoolos/contracts`: IDs, scopes, principals, the authorization vocabulary, capability manifests, configuration revisions, policy floors, errors, directory integrity checks and nanodollar money (`UsdNano`, ADR-0008). |
| `packages/schoolos-fixtures` | `@schoolos/fixtures`: two isolated synthetic districts. These are the only directory data tests may use. |
| `packages/schoolos-harness` | `@schoolos/harness`: boots both districts locally as isolated instances, each with a fake IdP, roster and AI provider. |

## Running the districts locally

```sh
pnpm schoolos:harness            # Northfield on :4801, Riverbend on :4802, until Ctrl-C
pnpm schoolos:harness -- --check # boot, check every /health over HTTP, exit
```

Each district serves `GET /health`, `GET /me` and `POST /ai/complete`, and the full district
application under `/api/` (see `@schoolos/district-app` below), seeded with demo content: an approved
resource and an installed activity in every active class, a student's essay in a personal and a
course workspace, one submission, an applied configuration revision and one AI request. The harness
prints a ready-made `curl` command with a token for one student, one teacher and one district
administrator per district. A token from one district's IdP is rejected by the other. Sign-in takes
the production path: each token's verified payload goes through `identityFromAccessPayload` and the
directory's `createDirectoryPrincipalResolver`, and the CLI shows Morgan Lee (one IdP subject in both
districts) landing on a different principal in each. `SCHOOLOS_HARNESS_PORT` moves the first port.
| `packages/schoolos-identity` | `@schoolos/identity`: resolves verified `(issuer, subject)` claims to principals, the Cloudflare Access adapter, admin-confirmed identity linking and the email-keyed migration plan (F04). |
| `packages/schoolos-identity-links` | `@schoolos/identity-links`: the district identity-link control. An append-only log of pending identity links and Workshop user adoptions (in memory, or Durable Object SQLite via `./durable-object-store`), and the district-admin service that lists, approves and rejects them under the policy engine, persisting every audit event and, for a confirmed adoption, the Workshop user rebind intent (SCHO-38). |
| `packages/schoolos-registry` | `@schoolos/registry`: Learning Registry records (frameworks, competencies, associations, resources, curriculum packs, evidence contracts), lossless CASE 1.1 codecs and a fetch-injected CASE client. `src/case/codec.ts` lists what CASE cannot express. |
| `packages/schoolos-config` | `@schoolos/config`: the configuration compiler. Capability registry and shipped pack manifests, the `schoolos.dev/v1alpha1` district document, revisions with diff and rollback, dry-run plans and form descriptors. |
| `packages/schoolos-integrations` | `@schoolos/integrations`: interoperability adapters, one namespace per standard. `oneroster` reads a OneRoster 1.2 bulk CSV export, previews it against the current directory, links IdP identities, quarantines mismatches, and applies only results that pass `checkDirectoryIntegrity`. |
| `packages/schoolos-lti` | `@schoolos/lti`: the LTI 1.3 broker. Platform registrations, launch validation, launch-to-principal and offering mapping, Canvas Deep Linking (I01), the client-side storage fallback for blocked cookies, and admin-approved dynamic registration. See [lti.md](lti.md). |
| `packages/schoolos-lti-district` | `@schoolos/lti-district`: the district side of LTI. The broker's stores on the district's Durable Object SQLite, NRPS rosters applied through `AcademicSync`, approvals read from E01 official grades, and the policy-authorized admin service for registrations and grade routes. See [lti.md](lti.md#district-wiring). |
| `packages/schoolos-catalog` | `@schoolos/catalog`: the reviewed framework catalog (CCSS, NGSS, C3, CASEL, ELOF, TEKS, Michigan) with licensing decisions and grade-band coverage, PlayTrek-derived seed releases, and the district-local catalog mirror (pinned releases, approvals, overlays, upgrade diffs, coverage report). |
| `packages/schoolos-content-studio` | `@schoolos/content-studio`: the Content Studio ingest pipeline (C03). SSRF-guarded URL import and magic-byte-checked uploads into quarantine, rights modes a teacher can only narrow, deterministic checks and an optional AI review that receives imported text only as delimited data (threat T7), a reviewer queue, approvals that create immutable `ResourceDescriptor` releases, native Blueprint releases pinned to their commit, and a Durable Object SQLite store. See [content-studio-ingest.md](content-studio-ingest.md). |
| `packages/schoolos-doc-extract` | `@schoolos/doc-extract`: bounded PDF and DOCX text extraction for Content Studio review (SCHO-79). A pure function under step, size and page caps; its output is untrusted data. See [content-studio-ingest.md](content-studio-ingest.md). |
| `packages/schoolos-cartridge` | `@schoolos/cartridge`: the Thin Common Cartridge importer (C04). A bounded `.imscc` reader (entry, size and ratio caps, no unsafe paths, symbolic links ignored) and a DTD-free manifest parser for CC and Thin CC 1.1-1.3. Web links wait in quarantine until a teacher submits one to the Content Studio; LTI links become external-tool references that are never launchable without an approved registration; the organization becomes a proposed curriculum outline. Other resource types are skipped and counted. |
| `packages/schoolos-curriculum` | `@schoolos/curriculum`: learning activities (C05). Four subject-neutral templates (writing task, science investigation, primary-source analysis, problem set) generate one runtime model; definitions are versioned and immutable once published, reference only Content Studio releases, and may only narrow the AI-help policy. Installations pin one version into one offering and term and publish the student-visible class Codex, which never holds teacher-only notes or answer keys and reaches the AI helper only as data (threat T7). |
| `packages/schoolos-ocs` | `@schoolos/ocs`: the Open Course Specification (C06). Course packages of units, activity and resource references, Codex notes and standards that include other packages as modules; a deterministic resolver that writes a byte-stable lockfile and verifies every package's digest; a composer that flattens a locked course into one outline with hide, reorder and rename overrides, per-item provenance and rights that only narrow; teacher composition with no Git vocabulary; and the export to curriculum installations. |
| `docs/schoolos/rfc/` | RFCs. [0001](rfc/0001-open-course-specification.md) specifies OCS 1.0, which is its own contract, not Thin CC. [0002](rfc/0002-integration-fabric.md) proposes the Integration Fabric (education operations, MCP, LTI and access configuration) and its IF-00 to IF-12 roadmap. |
| `docs/schoolos/standards-licensing.md` | What standards text may ship in this public repository, and why, framework by framework. |
| `packages/schoolos-installer` | `@schoolos/installer`: installs a release-key-signed release, verified offline against the release keys the district pins, into a district's Cloudflare account, through OAuth or a district-run token. It runs preflight, then reconciles desired against actual state with ownership checks, resumes after interruption, and supports rollback. Registering the instance with a registry is optional and off unless configured. Permissions are in [installer-permissions.md](installer-permissions.md); how releases are signed is in [release-signing.md](release-signing.md). |
| `packages/schoolos-releases` | `@schoolos/releases`: release manifests signed with rotating release keys, the `canary`/`stable`/`lts` channels, district-side offline verification of signed offers with approve, decline and defer, and migration gates over the installer's dry-run drift report. Its staged rollout, which halts on failing fleet health, is reference code for a release publisher and is not part of an installation. |
| `packages/schoolos-installer` | `@schoolos/installer`: installs a root-signed release, verified against the release keys the district pins, into a district's Cloudflare account, through OAuth or a district-run token. It runs preflight, then reconciles desired against actual state with ownership checks, resumes after interruption, and supports rollback. Permissions are in [installer-permissions.md](installer-permissions.md); how releases are signed is in [release-signing.md](release-signing.md). |
| `packages/schoolos-installer` | `@schoolos/installer`: installs a root-signed release, verified against the release keys the district pins, into a district's Cloudflare account, through OAuth or a district-run token. It runs preflight, then reconciles desired against actual state with ownership checks, resumes after interruption, and supports rollback. Permissions are in [installer-permissions.md](installer-permissions.md). |
| `packages/schoolos-releases` | `@schoolos/releases`: root-signed release manifests, release keys that change only through a key set signed by a threshold of offline root keys (rotation and emergency revocation), the `canary`/`stable`/`lts` channels, district-side verification of signed offers with approve, decline and defer, migration gates over the installer's dry-run drift report, upgrades refused while the entitlement has lapsed (rollbacks still allowed), and the root's staged rollout that halts on failing fleet health, offers a rollback and counts the decisions districts report. `@schoolos/releases/durable-object-store` holds the district release store and the rollout store, with an atomic offer sequence. |
| `packages/schoolos-district-app` | `@schoolos/district-app`: the district application. `createDistrictApp` composes the domain services over their storage interfaces (in-memory for now), around one `PolicyEngine` and one audit sink, behind a fetch-standard handler whose `/api/me`, `/api/student`, `/api/teacher` and `/api/admin` routes are declared once, with their Zod schemas, in `src/routes.ts`. Every request gets a correlation ID that its policy decisions are audited under. `src/adapters.ts` holds the glue between services. |
| `packages/schoolos-api-client` | `@schoolos/api-client`: the typed fetch client the UIs use, written against the district app's route table, so a call names a route and its input and response types come from the same schemas the server validates with. |
| `packages/schoolos-academics` | `@schoolos/academics`: the academic directory (A01). Schools, terms, catalog courses, offerings and enrollments behind a storage interface, with source-of-record enforcement, a local fallback HTTP service and MCP-style tools over the same rules. |
| `packages/schoolos-policy` | `@schoolos/policy`: the ABAC policy engine (A02). A named, data-driven rule table over trusted directory facts, content-free decision audit, and the school tool contract that re-authorizes every MCP and agent tool call, with an approval queue for calls that wait for a person. |
| `packages/gatekeeper-schoolos` | `@schoolos/gatekeeper`: the Workshop gatekeeper Worker that gives agents the district's school tools (A02b). The subject is the principal the district verified when the account was connected, reads are recorded as observations, and every write waits in the policy approval queue for a person's decision. See its README. |
| `packages/schoolos-workspaces` | `@schoolos/workspaces`: stable personal and course workspaces, provisioned lazily per student, with a lifecycle derived from term state and retention, legal hold, term close and rollover, and promotion links. |
| `packages/schoolos-learning-artifacts` | `@schoolos/learning-artifacts`: artifacts and their immutable, content-addressed revisions, held inline or in R2 with digest verification on read, or recorded as approved external references. Save, history, pin, share, export and sanitized baselines. |
| `packages/schoolos-artifacts-git` | `@schoolos/artifacts-git`: project artifacts on Cloudflare Artifacts. Multi-file notebooks, code and datasets saved as Git-backed revisions, with Save, History and Diff, short-lived per-principal Git credentials, and sanitized forks of teacher baselines. See [artifacts-git.md](artifacts-git.md). |
| `packages/schoolos-assessment` | `@schoolos/assessment`: assignments bound to offerings, digest-pinned submission snapshots with receipts, anchored feedback with labelled suggested scores, and the teacher-approved official grade gate (E01). |
| `packages/schoolos-assessment-ci` | `@schoolos/assessment-ci`: Assessment CI (E02). A deterministic evaluator SDK with pinned releases, built-in evaluators, teacher-signed rubric releases, and idempotent assessment runs whose evidence reaches feedback only as labelled suggestions. |
| `packages/schoolos-assessment-ai` | `@schoolos/assessment-ai`: the optional Assessment CI backends (E03). AI feedback through a governed model port with excerpt-verified evidence, an execution sandbox that fails closed, teacher overrides and releases, and rubric report view models. See [assessment-sandbox.md](assessment-sandbox.md). |
| `packages/schoolos-portability` | `@schoolos/portability`: learner portability (P01, P02). The deterministic `.schoolos` student archive and its exporter, bounded validation, a git export of an artifact's history, the CLR 2.0 seam, and consented cross-district transfer. See [schoolos-archive-format.md](schoolos-archive-format.md). |
| `packages/schoolos-fleet` | `@schoolos/fleet`: optional, non-default reference code for the fleet protocol (R01): allow-listed wire messages, Ed25519 signed envelopes, a district-side agent, a reference instance registry and an offline entitlement cache. No default install uses it, and the default runtime checks no entitlements (ADR-0011). Release signing still borrows its `SigningIdentity` until that moves (IF-00b). |
| `packages/schoolos-commerce` | `@schoolos/commerce`: optional, non-default reference code from the withdrawn commercial control plane (R04): plans, subscriptions, invoices, grant credit ledgers, a payment processor port, signed entitlement issuance and a finance audit. Nothing in an installation depends on it, and whether it stays in the repository is an open owner decision (ADR-0011). |
| `packages/schoolos-fleet` | `@schoolos/fleet`: the fleet protocol (R01). Allow-listed wire messages, Ed25519 signed envelopes, the district-side agent, a reference root instance registry and the district's offline entitlement cache. The registry accepts a registration only once the commercial system vouches for its `commercialAccountId` (a `CommercialAccountVerifier` port; contact details never cross the protocol), rekeys an instance with its single-use ownership token and revokes the old key, and records signed release decisions. `@schoolos/fleet/durable-object-store` holds the agent's durable sequence counter and the Durable Object helpers the releases and commerce stores share. |
| `packages/schoolos-commerce` | `@schoolos/commerce`: the root control plane's commercial layer (R04). Plans, subscriptions with grace rules, purchase orders, integer-cent invoices, grant credit ledgers, a payment processor port with a `fetch`-based Stripe adapter (webhook signatures verified) and a fake, signed entitlements, verification of fleet registrations, and an append-only, hash-chained finance audit. Invoices charge SchoolOS fees only: a district's AI spend is its own, on its own Cloudflare bill, so an opted-in heartbeat's figure appears on a zero-amount reporting line and is never charged (SCHO-98). Every operation, a webhook with all its effects included, commits atomically; `@schoolos/commerce/durable-object-store` is the Durable Object store. |
| `packages/schoolos-portability` | `@schoolos/portability`: learner portability (P01, P02). The deterministic `.schoolos` student archive and its exporter, bounded validation, a git export of an artifact's history, the CLR 2.0 seam, the record source over assessment (E01) and Content Studio (C03) records, and consented cross-district transfer signed with the fleet agent identity, with revocation notices and atomic import. See [schoolos-archive-format.md](schoolos-archive-format.md). |
| `packages/schoolos-fleet` | `@schoolos/fleet`: the fleet protocol (R01). Allow-listed wire messages, Ed25519 signed envelopes, the district-side agent, a reference root instance registry and the district's offline entitlement cache. |
| `packages/schoolos-commerce` | `@schoolos/commerce`: the root control plane's commercial layer (R04). Plans, subscriptions with grace rules, purchase orders, integer-cent invoices, grant credit ledgers, a payment processor port, signed entitlements and an append-only finance audit. |
| `packages/schoolos-student-ui` | `@schoolos/student-ui`: the Student Learning Home (U01), a Vite React app over `@schoolos/api-client`. |
| `packages/schoolos-teacher-ui` | `@schoolos/teacher-ui`: Teacher Studio (U02), a Vite React app over `@schoolos/api-client`. |
| `packages/schoolos-admin-ui` | `@schoolos/admin-ui`: the district admin console (U03), a Vite React app over `@schoolos/api-client`. |
| `packages/schoolos-pilot-gate` | `@schoolos/pilot-gate`: the synthetic pilot gate (H01). The security, availability, rollover, load, restore and accessibility suite over both districts' apps, and the G0/G1 gate report. Test-only. See [pilot-gate.md](pilot-gate.md). |

## Decisions

1. [District data ownership and root independence](adr/0001-district-data-ownership.md)
2. [Package boundaries and kernel seams](adr/0002-package-boundaries.md)
3. [Issuer-qualified principal identity](adr/0003-principal-identity.md)
4. [Capability packs and policy floors](adr/0004-capability-packs-and-policy-floors.md)
5. [Default-deny authorization vocabulary](adr/0005-authorization-vocabulary.md)
6. [Reusing PlayTrek code](adr/0006-playtrek-ip-boundary.md)
7. [Hall Monitor and the kernel AI call guard](adr/0007-hall-monitor-and-ai-call-guard.md)
8. [AI spend in integer nanodollars](adr/0008-usd-nano-money.md)
9. [SchoolOS libraries type-check against the web-standard surface](adr/0009-typings.md)
10. [One rule table, record-backed grants, and flags that need a second reviewer](adr/0010-one-rule-table-and-record-grants.md)
11. [Open-source charter and module ownership](adr/0011-open-source-charter-and-module-ownership.md)
9. [Comprehensive Learner Record issuer](adr/0009-clr-issuer.md) (Proposed)

## Rules every SchoolOS change follows

- No student or teacher content leaves the district's account. `schoolos.dev` is never in the data path.
- SchoolOS runs entirely in the organization's account. `schoolos.dev` may host documentation, an
  optional guided bootstrap and public releases. It never mediates runtime access, issues runtime
  tokens or gates features.
- No paid-gated core: no entitlement checks, subscription callbacks, student-data fleet reporting or
  remote administrative access in the default runtime. Instance registration is opt-in,
  content-free and off by default.
- Releases are verified offline against keys the organization pins.
- Claims about standards support match [maturity.md](maturity.md). No 1EdTech certification is
  claimed.
- Identity is `(district, issuer, subject)`. Email is display metadata.
- Every HTTP route, MCP tool and agent action authorizes through the same vocabulary and denies by default.
- Narrower scopes may tighten district policy, never loosen it.
- Closing a term, dropping an enrollment or losing a roster row never deletes work.
- Tests use `@schoolos/fixtures` and reserved `.example` domains. Never use real people.
