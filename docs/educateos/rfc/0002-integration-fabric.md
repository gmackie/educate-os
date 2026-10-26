# RFC: EducateOS Integration Fabric — Education Operations, MCP, LTI and Access Configuration

**RFC proposed** `SCHO-IF-001` · **Date:** 2026-10-21 · **Status:** Proposed · **Owners:** Open-source EducateOS maintainers and installing organizations

## 0. The product we're actually building

An educator installs one open-source monorepo into **their organization's Cloudflare account**. It includes: local administrative dashboards; lightweight educational records, assignment and family handoffs; native Teacher Studio/Workspaces; a standards and activity registry; a curated, secured MCP server; LTI 1.3 Tool / LTI Advantage and eventually LTI Platform functionality; a source-of-record registry and provider connectors; a unified access-policy UI; Hall Monitor and AI cost governance; diagnostics, backups and recovery. The organization can run without any hosted `educateos.io` runtime services or commercial feature entitlements.

**Integrator value:** People and external tools interact with *educational capabilities*, not database tables. EducateOS can fulfill an operation from a small local CRUD-lite provider or from an approved SIS/LMS adapter, while the security check, human review, audit trail and API contract stay the same.

**Teacher/co-op value:** An administrator can choose “who may see the Biology roster, create assignment drafts, publish learning activities, and pass grades back?” and test that answer without writing OAuth rules, editing code or understanding D1.

**Do not build:** a second ClassBack-sized 400-operation SIS; a public MCP server mirroring all school records; a privilege-bearing agent identity invented by prompts; a central EducateOS SaaS backend; a one-size-fits-all connection toggle that silently selects record ownership.

---

## 1. Grounded inventory: don't reimplement existing code

| Existing | Location | Reuse or extension decision |
|---|---|---|
| ClassBack education semantics | `gmackie/classback` `api/openapi.yaml`, `internal/models`, `internal/modules/{core,classroom,grades,integrations,communications}`, `internal/handlers` | Map the *domain concepts, operations and validation cases*. Extract/reimplement compatible fixtures and adapters; avoid copying whole Go application into Workers |
| ClassBack LTI / SIS knowledge | `internal/lti`, `internal/services/lti_{ags,nrps,deep_linking}_service.go`, `internal/sis/adapters/oneroster` | Compare edge cases and tests to EducateOS. Do not assume docs equal live, compliant behavior |
| ClassBack modular providers | `internal/modules/{module.go,registry.go}` and provider interfaces | Keep optional local/external source selection. Do **not** port an untyped Go registry (`map[string]any`) directly |
| EducateOS academic operations | `packages/educateos-academics/src/{directory,operations,http,tools}.ts` | **Primary contract prototype:** one `ACADEMIC_OPERATIONS` table dispatches HTTP and MCP-style tools through `invokeOperation` |
| EducateOS resource policy | `packages/educateos-policy/src/{engine,tools,academics}.ts`, `docs/educateos/adr/0005-authorization-vocabulary.md` | Continue default-deny per-resource authorization; every tool execution gets a verified principal and target |
| EducateOS identity | `packages/educateos-identity`, ADR-0003 | District-local opaque principal and trusted verified `(issuer,subject)` identity links; roles from institutional grants/roster, never untrusted LTI claims |
| EducateOS LTI Tool and Advantage client | `packages/educateos-lti/src/{broker,deep-linking,service-client,nrps,ags,passback}.ts` | Preserve tested Tool side, finish durable stores and real LMS harnesses; extend separately to Platform side |
| EducateOS OneRoster | `packages/educateos-integrations/src/oneroster` | Use quarantine, source-of-record selection, diff/apply; do not silently remove historical records |
| EducateOS capability configuration | `packages/educateos-config`, `packages/educateos-contracts/src/capability.ts`, ADR-0004 | Use existing manifests, schema-derived forms, revisions, dry run and policy floors rather than parallel admin flags |
| EducateOS MCP infrastructure | `packages/gatekeeper-mcp`, `packages/mcp-shared`, `SchoolToolRunner` | Connect curated education tools to external MCP transport and OAuth; local tool arrays alone do not establish externally usable MCP |
| EducateOS district API | `packages/educateos-district-app/src/routes.ts` and adapters | Extend domain-aware route table; durable D1/DO bindings and full bootstrap need verified production work |
| EducateOS local admin UI | `packages/educateos-admin-ui` | Add a single **Connections & Access** experience; don't start a new frontend stack |

### Immediate documentation repairs

- Rewrite `docs/educateos/adr/0001-district-data-ownership.md` to remove the erroneous *commercial root control plane*, entitlements and default fleet reporting. Root independence and organization ownership remain.
- Mark `educateos-commerce` and `educateos-fleet` as out-of-scope for mandatory runtime. Remove proprietary feature gating. Optional open-source release discovery and package/catalog publication do not require a central trust service.
- Explicitly license reusable ClassBack source and audit third-party dependencies/assets before source extraction. A README MIT badge is not a licensing instrument.
- Add a code-vs-design maturity table that makes claims such as “has LTI specs and service classes” distinct from “passed conformance tests against Canvas/Moodle” or “fully interoperable LTI Platform.”

---

## 2. The kernel boundary: EducationOperation as the one executable contract

**Do not put LTI logic, MCP routing and REST permission middleware inside the model/domain handler.** Introduce a generic operation definition only to the extent it extends the already-working `ACADEMIC_OPERATIONS` pattern. An `EducationOperation` is a versioned, schema-checked semantic operation. Its definition contains:

1. Stable ID and version (e.g. `educateos.assignment.create_draft.v1`).
2. Input and output schema and constraints.
3. Accepted caller channels: `ui`, `rest`, `mcp-agent`, `lti-service`, `internal-job`.
4. Required capability and legal resource classification.
5. Target-resource resolver from persisted records, not client-supplied claims.
6. Actor/delegation policy and scope ceiling.
7. Source-of-record domain (`assignments`, `grades`, `rosters`, etc.) and supported provider methods.
8. Effects: read, draft, publish, approve, export, delete; strong idempotency for important writes.
9. Human approval policy for consequential writes; an approval cannot be fabricated in tool arguments.
10. Audit ID, correlation, evidence and result metadata.
11. Optional model budget requirements and moderation checkpoints (only for AI activities).

A single handler executes this pipeline:

```text
[REST, admin UI, MCP, LTI or trusted job]
       | verify protocol identity and registration
       v
Resolve district-local Principal + verified actor mode
       | never trust input roles, emails or arbitrary tool metadata
       v
Check feature installed / enabled / exposed to current scope
       v
Parse STRICT operation input; resolve actual stored target and classification
       v
Default-deny ABAC: principal × action × resource × term × delegation × policy floor
       | if high-impact: return approval-required, no side effect
       v
Provider authority: exact source, supported op, connector health, ownership
       | never quietly write to a different gradebook
       v
Execute authorized provider method with idempotency/version preconditions
       v
Audit decision, provider result, spend, safety or review receipts
```

**Invariants:** authorization before side effects; check still-valid authorization when deferred execution runs; no agent-chosen arbitrary provider; explicit version/ETag on conflicting writes; no hidden replacement of an external source with local fallback for official records.

### Sample operation matrix (initial scope)

| Operation | Record scope | Caller(s) | Local CRUD | Optional external | Default review |
|---|---|---|---|---|---|
| `school.me` | Self | UI, REST, MCP | Yes | IdP projection | No |
| `academic.list_offerings` | Enrolled/taught offerings | UI, REST, MCP | Yes | OneRoster/NRPS projection | No |
| `academic.get_roster` | Assigned offering | UI, REST, curated MCP | Yes | NRPS/OneRoster | Optional data-minimization step |
| `curriculum.list_approved` | Published resources | UI, REST, curated MCP | Yes | Approved resource references | No |
| `assignment.create_draft` | Teacher's offering | UI, REST, curated MCP | Yes | Canvas adapter where supported | No |
| `assignment.publish` | Teacher's offering | UI, REST, MCP with approval | Yes | LTI Deep Linking/resource link or LMS API | Teacher approval for AI-drafted work |
| `submission.get_review` | Assigned reviewer + student | UI, REST, curated MCP | Yes | LMS submission read adapter | Sensitive read permitted only when necessary |
| `assessment.propose_feedback` | Assignment/submission | Teacher UI, internal job; constrained MCP | Yes | Optional assessment adapter | Advisory only |
| `grade.approve` | Teacher's student/assignment | Teacher UI, REST | Yes | Local workflow | Human approval only |
| `grade.passback` | Approved grade version | Internal job after teacher approval | No new grade, only publishing | LTI AGS / approved LMS adapter | Always |
| `family.weekly_plan` | Authorized family's class | UI, REST, trusted notification job | Yes | Existing LMS links | Instructor publication |

**Curated MCP exposure:** `grade.approve`, guardian relationship edits, organization-wide roster exports, data deletes, identity links and highly sensitive records should **not** be exposed as general-purpose agent tools in v1. An approved automation can request an operation requiring a person to complete a separately authenticated confirmation flow.

---

## 3. Canonical education data model (source-neutral)

Use the types already defined under `@educateos/contracts`, academics, curriculum and assessment as the baseline; ClassBack models are migration/comparison input, not parallel persisted objects.

```text
Organization/District ── School (optional for co-op)
                  ├── Principal ── ExternalIdentityLink*(issuer,sub)
                  │              ├── RoleGrant(scope,dates)
                  │              ├── GuardianRelationship(scope,consent,restrictions)
                  │              └── AgentDelegation(grantor,client,scope,expiry)
                  ├── Term
                  ├── Course (catalog) ── Offering (term+section)
                  │                        ├── Enrollment(principal,role,status)
                  │                        ├── ActivityInstallation
                  │                        │      └── AssignmentBinding
                  │                        └── Workspace(course context)
                  ├── ContentRelease/ResourceDescriptor
                  ├── ArtifactRevision/SubmissionSnapshot/Feedback
                  ├── GradeProposal/TeacherApproval/OfficialGradeVersion
                  ├── IntegrationRegistration / ProviderAuthority / SyncRun
                  ├── CapabilityManifest / ConfigurationRevision
                  └── AuditEvent / ReviewRequest / UsageReceipt
```

### Mapping rules

- `ClassBack.User` with a top-level role => opaque `Principal` plus **scoped** `RoleGrant`. A user can be parent, teacher, volunteer and administrator with separate scopes and expirations. Do not authenticate with email or inherit admin authority from an LMS claim.
- `ClassBack.Class` => EducateOS catalog `Course` plus term-specific `Offering`, not a single flat entity. Student and co-teacher relationships attach to offering/term.
- `ClassBack.StudentParentRelationship` => scoped guardian relationship, requiring family-specific visibility restrictions and applicable consent processes. A guardian record is not equivalent to authorization for every child's sensitive record.
- `ClassBack.Assignment`, grade and gradebook => EducateOS activity/assignment binding, evidence snapshots, teacher-approved grade versions; a grade proposal is never official merely because an evaluator returned a score.
- `ClassBack.LTIConsumer`, tool registration and role link => `PlatformRegistration`, verified identity link, offering-to-context map and explicit tool grants in EducateOS.
- `ClassBack.Attendance`, transport, cafeteria and medical records are **not** compulsory CRUD-lite schemas. Keep advanced ClassBack APIs as separately approved optional provider integrations rather than silently inheriting their broad PII surfaces.

**Migrations:** baseline mock fixtures include two co-ops, one mixed-age Biology class, parent-instructor dual role, Canvas-delivered gradebook and a student with multiple personal/course artifacts. Mapping tests enforce no data loss on supported fields, reject unsupported sensitive fields, and preserve external IDs only in scoped identity/provider link tables.

---

## 4. CRUD-lite with provider routing: one source of record per operation

### Native storage profile (recommended)

- **D1** — relatively conventional indexed entities: schools, principals/profile references, offering/terms, assignments, publish state, registration metadata, provider authority/sync status and immutable audit index. Choose migration/versioning policy and verify real limits before production.
- **Durable Objects with transactional SQLite** — atomic nonce/state take-once, LTI launch sessions, grade-passback idempotency claims, policy/financial budget admission, task coordination and contention-heavy state. Do not assume cross-DO atomic transactions.
- **R2** — binary uploads, student evidence, curriculum assets, backups and export archives; envelope encryption and retention policy according to organization needs.
- **Artifacts** — optional versioned text/source material, immutable published packages; not the only storage for media or official audit records.
- **Queues/Workflows** — retries, roster synchronization, communications and asynchronous assessment jobs, with idempotency/outbox semantics.

The storage owner is the organization. `educateos.io` never hosts a required D1 database, trusted JWT issuer or student-data API.

### Provider authority map

Each data domain and operation has **one explicitly configured authority**, with optional nonauthoritative read projection or writeback:

| Domain/operation | Co-op without LMS | School with existing LMS/SIS |
|---|---|---|
| People / identity | Local invitation/OIDC linking | Local principals + trusted IdP identity links |
| Classroom catalog/terms | Local CRUD-lite | Local or authoritative SIS, selected explicitly |
| Course enrollment | Local | OneRoster/verified roster sync; NRPS as supplemental projection where mapped |
| Assignment publication | Local | Canvas or other approved provider, or local with Deep Linking |
| Student submission | Local artifacts | Per-activity source of record configured |
| Official grades | Local teacher-approved ledger | External LMS via explicit route and teacher-approved AGS |
| Content resources | Local approved catalog | Local catalog referencing approved external LMS/publisher content |
| Family weekly digest | Local notifications | Local communications or links into existing parent portal |

Authority binding is versioned (`source`, `scope`, `domain`, `allowedOperations`, `writeMode`, `syncDirection`, `conflictPolicy`, `configuredBy`, `revision`). A provider can serve read-only projections without authority to create or modify primary records.

**Safe sync:** fetch → validate schema → normalize IDs → compute diff → quarantine collisions/large removals → authorized preview → apply atomically where possible → audit → periodic reconcile. Departed learners should be *deactivated*, not physically removed from historical submissions. Connector outage should show cached, timestamped read-only data where privacy permits; it must not quietly flip write authority to local.

**Write actions:** optimistic version preconditions, atomic outbox when feasible, idempotency keys and a human-visible retry ledger. Never claim exactly-once network delivery: an external platform can accept a grade before our acknowledgement; retries must carry stable identifiers/time/version to minimize duplicates and reconcile actual remote state.

---

## 5. Three interfaces, three security protocols, one authorization decision

### REST / Admin UI

The local dashboard uses the same typed fetch API declared in `@educateos/district-app` route table and validated with Zod/Effect schemas. An external user cannot change the acting principal in JSON. Use real HTTP status codes, conditional updates, request IDs and RFC-compatible problem/error contracts where appropriate. OAS documents are generated from explicit approved operations, never used to expose private internal methods automatically.

### MCP (organization's own `/mcp`)

The target is **MCP protocol revision `2026-07-28` (stable)** and a pinned TypeScript v2 SDK supporting modern stateless requests plus legacy `2025-11-25` interoperability when necessary. MCP modern transport has `server/discover`, no protocol-level session handshake, request `_meta`, `Mcp-Method`/`Mcp-Name` headers, cache hints on listings and MRTR for interactive clarification/approval; long-running Tasks live in an extension. Do not design authorization around a persistent MCP transport session; authorization and resource checks happen on every request. See [MCP July 2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [MCP SDK guidance](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions).

Publish protected-resource metadata per **RFC 9728** and discover issuer metadata per **RFC 8414**. Use authorization code plus PKCE for user-delegated clients, resource indicators/audience restriction per **RFC 8707**, `iss` response validation per **RFC 9207**, short-lived tokens and local revocation. MCP `2026-07-28` favors **Client ID Metadata Documents** over dynamic registration; implement compat only as necessary for real client support. Client registration and user OAuth consent do **not** grant academic roles; they can only attenuate verified local rights. See [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) and [MCP auth revision](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

A usable MCP API has: authenticated transport, discovery, tool catalog, `tools/call`, safe resource read tools, explicit input bounds, approval gates, scoped revocation, per-call audit and tool-output data minimization. A local array of `AcademicTool[]` is **not** sufficient.

**Cache:** `tools/list` and `resources/list` may be cached, but per-request authorization is mandatory; private catalogs must use `cacheScope: private` and short/zero TTL while policy revisions are changing. Tool names/annotations are not policy authorities. `Mcp-Method`/`Mcp-Name` headers aid routing/observability but must not replace parsing/authorizing the method and target in the body.

### LTI Tool + Advantage

Already significantly implemented in `@educateos/lti` as a **Tool**: LTI 1.3 OIDC login/launch, deployment/issuer/client validation, Canvas Deep Linking fixtures, AGS and NRPS service clients, teacher-approved grade passback. **Finish** durable nonce/state stores, organization setup UX, sandbox Canvas/Moodle validation and conformance checks.

**LTI Platform** is a different target: EducateOS as host for third-party tools. Requires platform-key discovery/JWKS and OIDC initiation, registered tool deployments, platform-signed launches, scoped tool service tokens, platform **NRPS server**, **AGS server** and Deep Linking receiver. That adds work but makes a co-op with no LMS able to run vetted LTI tools on its local EducateOS instance.

**Terminology:** Formal core is **LTI 1.3 + LTI Advantage** = Deep Linking 2.0 + NRPS 2.0 + AGS 2.0, with a specific 1EdTech conformance process. “Advantage+” is product shorthand, not a certification. Additional services have different maturity levels (Dynamic Registration, Context Groups, Platform Notifications, Submission Review, etc.) and need individual adapter support and compatibility tests. See [1EdTech Conformance Guide](https://standards.1edtech.org/lti/specifications/guides/conformance/conformance-guide).

**IMPORTANT:** Google Classroom integration uses Google OAuth APIs and vendor-specific conditions; do not present it as a generic LTI 1.3 Platform. Source-of-record configuration must distinguish Google Classroom API scopes from AGS permissions.

---

## 6. Effective access = intersection of independent controls

For any attempted operation, EducateOS computes:

```text
EffectiveAllow = ValidAuthentication
  ∩ ActiveTrustedPrincipal
  ∩ EnabledAndExposedCapability
  ∩ OAuthScopeOrRegisteredLtiServiceGrant
  ∩ InstitutionalRoleAndResourceABAC
  ∩ CurrentEnrollmentAndTermState
  ∩ DelegationBoundedByGrantorAndClient
  ∩ AppropriateSourceOfRecordAndProviderRight
  ∩ RequiredHumanApproval (when applicable)
  ∩ CurrentSafety/BudgetPolicy (for AI actions)
```

No one factor is sufficient. An LTI Instructor role label is not an institutional grant; OAuth scopes are not gradebook privileges; a course teacher does not automatically see a student's personal chat; a connected MCP client cannot automatically enumerate every course; safety classifier probabilities never grant access.

### Actor types

| Actor | Identity evidence | Authority granted |
|---|---|---|
| Human organization admin | Verified organizational IdP or local account + role grant | Administrative operations on approved scopes, with high-impact confirmation |
| Teacher/co-teacher | Verified principal + active offering enrollment | Approved class work, drafts/reviews; no silent global roster/export privileges |
| Student | Verified principal + course membership and age policy | Authorized published tasks and submissions; AI optional, bounded |
| Guardian | Verified principal + specifically authorized child relationship | Defined work/progress records; excludes unrelated children and private content |
| MCP delegated assistant | Verified OAuth client + on-behalf-of principal + explicit delegated grant | **Intersection** of grantor's rights, client grant and policy floor, each call revalidated |
| Autonomous service agent | Local service principal + job-specific capability grant | Narrow nonhuman scopes; no implied human impersonation |
| LTI external tool | Registered `(issuer,client,deployment)`, verified launch or service token | Only approved offering/resource operations for that tool; limited roster/grade service capabilities |
| Internal background job | Signed service identity + task registration + budget/safety policy | Bounded operation approved for that source; records purpose, origin and audit |

### Delegated MCP actor specifics

A teacher authorizing an AI tool to `assignment.create_draft` for one Biology offering must NOT confer grade writes, sibling/guardian data reads, other courses, future term membership, or arbitrary storage access. When teacher's roster status changes, access to the offering is revoked even if a previously issued OAuth token has not expired. The instance checks the authoritative roster on each sensitive call; use short token TTL plus revocation for responsiveness. Do not pass a powerful underlying LMS service credential to an MCP client.

### Human approval is a transaction, not a flag

A request to publish a draft may return `approval-required` with an opaque `approvalRequestId` bound to content digest, operation, principal, target and expiration. A teacher reviews the *exact proposed effect* in EducateOS. Approval is recorded by trusted server action (not agent tool arguments), then a separate execution step rechecks policy, provider authority, versions, and idempotency. The approved command is not replayable for altered content.

---

## 7. Administrator UX — Connections & Access

The user-facing feature should be a single local `/admin/connections` area, organized around tasks rather than protocols. The page displays installed modules, supported external connection types, source-of-record ownership, reachable endpoints, and what each connection is *allowed to do*.

### Wizard for external MCP client

1. **Choose:** `AI assistant / agent` (MCP) → give client friendly name and trusted origin.
2. **Discover:** show instance `https://school.example.org/mcp`, RFC 9728 metadata and local issuer / supported grant types; validate compatible client metadata document or explicitly registered client.
3. **Choose identity:** delegated teacher (`on behalf of`) or independent local service identity (without impersonation).
4. **Scope:** which School, Offering, Term, Personal Workspace or Published Resource set? Default is one class; no organization-wide enumeration grant.
5. **Capabilities:** check vetted actions (read materials, view roster subset, create drafts, publish request), with writes requiring separate human approval.
6. **Preview:** compute effective permissions and explain both allowed and denied scenarios. Show sensitive data types and any external providers involved.
7. **Test + activate:** run synthetic or real consented dry-run and a denied call, show audit correlation IDs; store revision and permit one-click revoke.

### Wizard for external LMS (EducateOS as Tool)

1. Choose Canvas/Moodle/Blackboard/generic registered LTI 1.3 Platform.
2. Generate copy/paste registration metadata and/or well-defined setup guide; exact issuer/client/deployment/redirect/JWKS endpoints.
3. Test an instructor and learner launch with seeded non-PII fixtures; bind LMS context to known offering (never auto-grant teacher role from LTI claim).
4. Choose which LTI Advantage services are enabled: Deep Linking, NRPS and AGS scope, each separately consented and testable.
5. Preview source-of-record implications. Example: Canvas is gradebook, local EducateOS is lesson-authoring origin; grade passback is initially disabled.
6. Preview approved teacher workflow and synthetic grade passback before activating real write permissions.
7. Monitor token expiry, failing launches, stale course mapping, missing service scope, errors and key rotation from the local console.

### Wizard for EducateOS-as-LTI-Platform (no external LMS)

1. Register a third-party LTI Tool with metadata/JWKS/redirects, supported services and trusted host.
2. Choose which course offering(s) may launch it, learner data privacy mode and expected roster fields.
3. Approve NRPS access and AGS writeback independently with strict scope and identity mapping.
4. Dry-run teacher launch, learner launch, invalid issuer/deployment and attempted out-of-class roster request.
5. Publish one third-party interactive activity into EducateOS and manage the tool's access/revocation in local admin UI.

### Three local sections

**Connections:** status `Not configured → Registered → Verified → Enabled → Healthy / Needs attention`, last success, protocol and capabilities, credential owner, docs and test button.

**Data ownership:** domain ownership map and import/sync status; read/write direction, conflict/exit policy, retry state and impacted offerings. Anything that changes the authoritative provider uses a migration/dual-run plan with explicit confirmation and rollback, not just a dropdown.

**Access:** *Who can do what?* A visual policy simulator to choose actor, role, course, operation and target; returns `Allowed`, `Denied`, or `Teacher approval required` with reason codes and source-of-record details. Simulations must show *effective* rights, not merely checkboxes.

### Accessibility/usability basics

Administrators should not need to know OAuth claim URIs, MCP protocol headers or LTI token URLs for routine setup. Provide progressive disclosure for advanced settings, accessible keyboard controls and field explanations, error messages with next steps, and direct links to unambiguous local audit and connection test results. One class/one tool demo should not require touching Cloudflare console beyond initial account provisioning.

---

## 8. Concrete security and operational threats

| Threat / failure | Mitigation | Release test |
|---|---|---|
| ClassBack route-permission map implicitly allows unmapped routes | Do **not** port permissive middleware; use closed default-deny `SchoolToolRunner` and typed HTTP auth | Unknown endpoint/tool/action denied |
| Tool calls spoof `actingAsTeacher` or arbitrary role | Subject from verified OAuth/LTI/local session, never JSON | Forged principal and injected model role denied |
| MCP token replayed against unrelated resource | Audience restricted tokens and RFC 8707 resource identifier | Wrong `aud` rejected |
| A cached MCP tool list outlives permission changes | Listing is never enforcement; per-call ABAC; private cache short/zero TTL | Revoke then call returns denied immediately |
| External LTI `Link` pagination URL leaks service token | Reject URLs with foreign origins/path, cap pages, prevent SSRF | Malicious cross-origin next-page denied |
| Canvas copies activity link into another course | Resolve link scoped to registered offering | Copied link does not reveal resource |
| AI-generated grade is silently written | Approval-bound exact version + AGS passback ledger | Unapproved or modified grade blocked |
| Guardian sees other child or private student chat | Scoped relationship and classification, term-aware | Sibling/alternate guardian isolation fixtures |
| Provider sync deletes 50 students because upstream outage | Stage preview/quarantine, require admin approval | Large negative diff held, local history untouched |
| ClassBack broad health/discipline/transport schemas exposed | Omit sensitive modules from CRUD-lite and default MCP list | No broad record class reachable without explicit pack |
| Token expiry or JWKS rotation interrupts classroom access | Versioned keys with grace, diagnostics, safe retry | Old signature revoked per policy, new one accepted |
| Root bootstrap site unavailable | No runtime root dependency, local configs and secrets | Full class lesson and authorization works root-offline |
| Source-of-record falls back silently | Fail visibly with last-good read and manual recovery, never covert writes | Provider down does not redirect official grade writes |
| Open-source ClassBack code copied without license file | Resolve explicit licensing before reuse; keep design/reference only meanwhile | Repository license audit / SBOM |
| Agent calls tools recursively without budget | Cost broker counts all calls and children; capability budget, tool rate and fanout ceilings | 100 concurrent disallowed/over-limit attempts blocked |

### Additional hardening

- Use issuer-qualified identities and distinct LTI vs MCP token audiences; no universal bearer accepted across every surface.
- Source provider credentials encrypted and held behind server-side adapter; never forward to agents, browser clients or generated Gadgets.
- Allowlist absolute service endpoints and defend against DNS/redirect-based SSRF and OAuth mix-up.
- Scoped structured audit without raw student prompts/PII; retention and support access local to institution.
- Rate-limit registration attempts, high-cardinality enumeration, bulk exports and roster searches.
- Helpdesk can diagnose connection status through redacted summaries; access to private records requires narrowly scoped JIT authorization and oversight.

---

## 9. Implementation topology in the batteries-included monorepo

Do not restructure upstream Workshop core simply to match ClassBack. Extend the packages that already exist:

```text
educate-os/
  packages/
    educateos-contracts/            # EXISTING: domain/resource/capability types
    educateos-academics/            # EXISTING: EducationOperation prototype, CRUD-lite
    educateos-policy/               # EXISTING: ABAC and tool runner
    educateos-lti/                  # EXISTING: LTI Tool and Advantage clients
    educateos-integrations/         # EXISTING: OneRoster adapters
    educateos-config/               # EXISTING: schema, pack manifests, revisions
    educateos-district-app/         # EXISTING: organization-local HTTP app
    educateos-admin-ui/             # EXISTING: local admin UI package
    educateos-identity/             # EXISTING: principal resolution
    mcp-shared/                    # EXISTING: MCP ecosystem primitives
    gatekeeper-mcp/                # EXISTING: external MCP integration

    educateos-provider-routing/     # PROPOSED: canonical authority map and provider methods
    educateos-mcp-server/           # PROPOSED: organization MCP transport / OAuth glue
    educateos-lti-platform/         # PROPOSED: Tool hosting, NRPS/AGS service provider
    educateos-connections/          # PROPOSED: connection registration / lifecycle
    educateos-access-simulator/     # PROPOSED: policy/effective-access explain API
    educateos-classback-adapter/    # OPTIONAL: ClassBack Go backend as approved provider
  docs/educateos/                   # ADRs, conformance, docs, admin install instructions
  examples/                        # Synthetic co-op, Canvas district, alternate guardians
```

**Caution:** proposed packages are not a requirement to create one package per feature. The first PRs should add code to existing packages, factoring out a new package only if it reduces coupling and has a clear public contract. The official Go ClassBack binary should not be a mandatory deployment unit. If an organization wants to run full ClassBack, treat it as an explicitly configured external provider (via private network/Cloudflare Tunnel), or evaluate optional Cloudflare Containers with real operations costs and compatibility tests.

---

## 10. Milestones and reviewable PR roadmap (delta from existing code)

Every PR below needs tests, documentation and a forward/backward compatibility note. This sequence is meant to **reuse current components**; never claim these PRs are already implemented merely because similar code exists.

| PR | Title / concrete code | Preconditions | Required acceptance evidence |
|---|---|---|---|
| **IF-00** | Fix open-source charter, remove commercial root/entitlement assumptions, document module ownership and license requirements | None | `educateos.io` offline test; docs promise no paid-gated core; ClassBack re-use not copied without license |
| **IF-01** | ClassBack-to-EducateOS contract crosswalk and golden fixtures | IF-00 | Canonical entity and operation fixtures: 2 orgs, 1 mixed-age class, 1 parent instructor, 1 Canvas course; no duplicate identities |
| **IF-02** | Durable `AcademicStore` adapters, transactional claims and migration/evidence | IF-01 | `workerd` restart persists terms, offerings, enrollments; no cross-account collisions; no unsafe cross-DO atomicity assumption |
| **IF-03** | Expand CRUD-lite: assignment drafts, publish, guardian relationships, weekly handoffs | IF-02 | Browser-created course and assignment persists; email/PDF source works with student AI disabled |
| **IF-04** | Operation descriptor and unified provider-routing semantics (only new domain operations) | IF-01/02 | REST and MCP run same handler and same policy verdict; source-of-record write conflict yields explicit error |
| **IF-05** | Organization MCP server using pinned current SDK, OAuth discovery, stateless transport and backwards compatibility | IF-04 | External MCP client passes discovery; allowed and denied tool; wrong aud denied; issuer mismatch; revoke immediately; cached listing never bypasses |
| **IF-06** | Organization access grant/delegation/approval registry and effective-access simulator | IF-04 | Teacher-created scoped agent cannot read other offering/sibling; approval executes exact digest and expires |
| **IF-07** | Admin Connections & Access wizard (MCP, sources, policy previews) | IF-05/06 | Configure an approved agent, preview effective access, revoke without CLI, see audit and provider source |
| **IF-08** | Complete LTI Tool/Advantage durable registration, Canvas + second LMS sandbox tests | IF-02/04 | OIDC/launch, AGS/NRPS/Deep Linking conformance fixtures, grade approval, spoofed claims/key rotation and replay tests |
| **IF-09** | Local LTI Tool registration wizard and diagnostics | IF-08 | Nontechnical admin registers Canvas, maps offering, verifies launch and AGS scopes without editing backend code |
| **IF-10** | EducateOS LTI Platform — tool host, signed launch, scoped NRPS/AGS/Deep Link | IF-02/04/06 | Trusted third-party tool can launch from EducateOS; restricted roster exposure; approved grade service actions |
| **IF-11** | Provider health, staged sync/diff, source-of-record migration wizard | IF-04/07 | OneRoster roster diff quarantined; external provider outage does not silently reassign grade authority |
| **IF-12** | End-to-end cross-protocol conformance, abuse/failover/cost coverage, SDK release docs | IF-05..11 | Real external MCP test client, live LMS sandbox, tenant isolation, root offline, full export and recovery exercise |

### Slice-first MVP (five deployable steps)

**Slice A: Local organization basics** — IF-00..03. Co-op admin logs in, creates a Biology offering, enrolls teacher/student and publishes a weekly plan with no LMS and no AI.

**Slice B: Same operation via REST/MCP** — IF-04..07. Teacher delegates a scoped agent to create an assignment draft; policy simulator and logs show exact allowed/denied actions.

**Slice C: EducateOS as LTI Tool** — IF-08..09. School with Canvas launches one EducateOS activity and optionally passes one teacher-approved grade back through AGS.

**Slice D: EducateOS as LTI Platform** — IF-10. Co-op registers a trusted educational simulation from a third party and launches it in EducateOS without an external LMS.

**Slice E: Operational hardening** — IF-11..12. Provider diff/quarantine, key rotation, backup, root-offline, audit export, crisis/AI cost safeguards.

### Explicit test matrix

For each operation and each surface (`UI/REST`, `MCP-modern`, `MCP-legacy`, `LTI-Tool`, `LTI-Platform`, `internal job`), run: valid self/teacher/admin, wrong course, expired role, cross-organization principal, guardian from another family, unregistered external client, withdrawn scope, incorrect provider authority, approval-required, duplicate write, stale version and infrastructure outage. Not every operation is exposed on all surfaces; missing/disabled exposure must refuse by design.

### Release gates

1. **Protocol gate:** reproducible MCP/1EdTech tests for every claimed integration. Certification is *not* claimed until formally obtained.
2. **Security gate:** default-deny, no cross-family/cross-organization leaks, no unsigned LTI launch, no external token forwarding, issuer/audience validation, short-lived scopes, read-only by default.
3. **Ownership gate:** deploy/test from source in customer-owned Cloudflare account with no `educateos.io` runtime calls; no private ClassBack or PlayTrek dependencies.
4. **Governance gate:** nontechnical admin can configure and revoke access from their own dashboard; dry-run explains effective authorization.
5. **Education gate:** no official grade writes from unapproved AI outputs; teacher review and provenance are explicit; student AI remains optional.
6. **Reliability gate:** actual connection health visible, safe failed sync, restart persistence, valid export and restored fixture.

---

## 11. A demonstrable scenario: a 40-family homeschool co-op

A co-op installs EducateOS into its own account from a pinned open-source release. Its volunteer administrator selects `homeschool-coop` profile, uses local accounts, creates a mixed-age science course, and adds two instructors. Basic term/roster/assignment state lives in local CRUD-lite; no paid SIS/LMS or centralized EducateOS SaaS is required.

One instructor enables a vetted MCP planning client **only for her own course**. The connection wizard grants `curriculum.list_approved`, `academic.get_roster` with minimally necessary fields, and `assignment.create_draft`. Publication is disabled for agents; roster export is disabled. A test query `list all students in every class` is denied. The instructor can still produce a lesson pack and weekly PDF/HTML digest through Teacher Studio without giving students direct AI access.

When the co-op chooses a third-party lab simulation, it registers the simulator as an LTI Tool hosted by EducateOS (Platform mode), restricts it to one offering and minimizes roster sharing. The admin sees “Biology Simulator can launch for learners in Science A, may read no family records, and cannot post a grade without a dedicated AGS permission.” Operations and cost are available under the local admin console.

**The selling point is demonstrable:** One accountable owner, one school-owned installation, a common access policy, and integrations that can be managed by nontechnical educators.

---

## 12. Batteries-included packaging and Hall Monitor distribution

**Delivery contract:** Cloning a tagged `educate-os` release and running its documented installer is sufficient to build and deploy the local application, CRUD-lite database, MCP endpoints, registered LTI services, administration UI, AI safety and usage ledger, health probes and backups. Optional providers require organization-owned credentials, but no privately hosted EducateOS dependency.

The shared Hall Monitor can retain an independent public source repository because PlayTrek also consumes it. **EducateOS must include an auditable, pinned build of Hall Monitor in its release**, with the source dependency and hashes available for offline/internal mirrors. The local installed Hall Monitor Worker, moderation policies and usage receipts live under the organization's Cloudflare account; no external Hall Monitor service is required. Prefer reproducible workspace packaging or a reviewed git subtree/vendor mirror for completely offline build environments. A git submodule alone without an available local clone can frustrate offline installations, so the release archive needs full dependency closure.

Store schema migrations, capability manifests, test fixtures, deployment permissions and local operator playbooks in the monorepo. Generate SBOMs and license notices. No commercial entitlements, central subscription callbacks, student-data fleet reporting or remote administrative backdoors are permitted in the default runtime.

### Admin operational acceptance

- Install through `educateos.io` optional guided bootstrap *or* fully from CLI/CI without visiting it; both produce equivalent local instances.
- Test registration and authorization for two independent external clients using the organization's host name and OAuth issuer.
- Admin can revoke one connection and observe immediate denial without restarting Workers or waiting for the bootstrap website.
- Offline root outage does not disrupt roster lookup, grade passback, local MCP, local Hall Monitor or admin operations.
- Export configuration, signed policy revisions, LTI platform registrations and integration status **without exporting secrets**; backup/restore D1/DO/R2 content according to organization policy.

---

## 13. The three design decisions still requiring explicit team review

**A. How much of ClassBack becomes built-in?** Recommendation: import/reconcile domain interfaces and fixtures for organization, people, course, enrollment, assignment, attendance-light, communications, grades; leave transportation, cafeteria, health and discipline outside the base Cloudflare deployment. Add a *read-only first* external ClassBack adapter if organizations already run it.

**B. What ships as EducateOS v1 external integration?** Recommendation: MCP modern/legacy and LTI **Tool/Advantage** first; LTI **Platform** as the next self-contained co-op capability. The spec-complete Platform role is substantially more work than authorizing Tool-side launches.

**C. Where does organization OAuth authorization live?** Recommendation: provision an organization-controlled, well-tested OAuth authorization service/broker supporting modern MCP discovery and delegated user consent; connect it to configured SSO. A third-party OIDC login alone does not automatically supply a standards-compliant MCP authorization server. The complete monorepo includes its own provisioning and diagnostic story and never depends on educateos.io for tokens.

---

## Sources and verification notes

**Source repositories:** `gmackie/classback`, `gmackie/educate-os`, `gmackie/playtrek` inspected through connected GitHub API on 2026-10-21. Existing docs sometimes lag code; test and conformance results have **not** been executed in this design exercise.

**Relevant public specifications:**
- https://standards.1edtech.org/lti/specifications/guides/conformance/conformance-guide
- https://standards.1edtech.org/lti/guides/implementation_guide/implementation-guide
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions
- https://www.rfc-editor.org/rfc/rfc9728
- https://www.rfc-editor.org/rfc/rfc8414
- https://www.rfc-editor.org/rfc/rfc8707
- https://www.rfc-editor.org/rfc/rfc9207

**Versioning caveat:** The live MCP specification has evolved from prior drafts and internal EducateOS plans. Pin an exact SDK/protocol compatibility matrix before implementing the external Worker transport; “MCP support” needs real external-client tests, not only compiling local tool contracts.

**License caveat:** The inspected ClassBack Git tree exposed no top-level LICENSE file though README/OpenAPI claim MIT. Verify explicit license and dependency grants before moving protected source into a publicly distributed monorepo.

## Grounding notes (2026-10-21)

Added when this RFC was committed (SCHO-168, IF-00), after checking it against the repository. They
correct or sharpen the text above; where they disagree, these notes win. Capability levels are
tracked in [maturity.md](../maturity.md), and the charter decisions in §0 and §12 are recorded in
[ADR-0011](../adr/0011-open-source-charter-and-module-ownership.md). ADR-0001 is Accepted, so §1's
"rewrite" was done as a dated amendment rather than by editing its decision.

1. **ADR-0010 is missing from §1.** The policy engine already has one rule table and record-backed
   grants ([ADR-0010](../adr/0010-one-rule-table-and-record-grants.md)). IF-06's agent delegation
   should be a `RelationshipSource` over delegation records, not a parallel grant mechanism.
2. **`gatekeeper-educateos` is missing from §1.** It already gives Workshop agents the district's
   school tools through `SchoolToolRunner`, as the principal the district verified, with
   `confirmWrites` approvals. It is the seam IF-05 and IF-06 extend.
3. **`educateos-identity-links` is missing from §1.** The district's durable, append-only identity
   link and Workshop user adoption control (SCHO-38) is where verified `(issuer, subject)` links
   are approved.
4. **"Approval is a transaction" (§6) mostly exists.** `packages/educateos-policy/src/approvals.ts`
   has approval IDs, states (`pending`, `claimed`, `applied`, `declined`, `expired`) and server-side
   decisions. Missing: a durable store, pinning the target and its version or digest in the
   approval, and rechecking provider authority when the approved call runs.
5. **The district app has a second route table.** `packages/educateos-district-app/src/routes.ts`
   declares 57 `RouteSpec`s with Zod schemas and does not dispatch through `ACADEMIC_OPERATIONS`.
   IF-04 has to reconcile the two rather than assume one table.
6. **IF-02 is larger than stated.** There is no district Worker (no `cloudflare.config.ts` for the
   district app) and no durable district stores; every district-app store is in memory.
7. **`AuthorityMap` and `GradeAuthority` already exist** in
   `packages/educateos-contracts/src/authority.ts`. IF-04 extends them instead of introducing a new
   provider-authority type.
8. **MCP in the repository today is client-only.** `@modelcontextprotocol/client` 2.2.0 speaks
   protocol `2025-06-18`. No MCP server SDK is installed and there is no OAuth resource server.
9. **The LTI paging guard checked origin only.** `packages/educateos-lti/src/service-client.ts`
   sent the bearer token only to the service URL's origin; §8's threat row needs origin and path.
   Resolved by SCHO-240: `assertNextPageUrl` also holds NRPS and AGS next pages to the first
   page's path.
10. **OneRoster has no large-removal hold.** Quarantine, all-or-nothing apply and
    deactivate-not-delete exist; holding a large negative diff for approval (§4, §8) does not.
11. **`RoleAssignment` lacks dates and guardian roles.** §3's `RoleGrant(scope, dates)` and
    `GuardianRelationship` need contract changes: today's role assignments carry no start or end
    date and have no guardian or parent role.
12. **MCP `2026-07-28` is confirmed** by the linked announcement: stateless requests, with
    `initialize` and `Mcp-Session-Id` removed; `Mcp-Method` and `Mcp-Name` headers mandatory on
    Streamable HTTP; dynamic client registration deprecated in favour of Client ID Metadata
    Documents; RFC 9207 `iss` validation required; Tasks moved to the
    `io.modelcontextprotocol/tasks` extension; list cache hints `ttlMs` and `cacheScope`. The
    announcement does not name the TypeScript SDK version that supports it, so IF-05 must pin one
    and record it.
