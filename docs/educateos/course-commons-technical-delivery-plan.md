# Course Commons — Technical Delivery and Pilot Program

**Status:** Proposed execution plan, 2026-11-15; not a shipped capability or a normative OCS revision.

**Companions:** [Operating model](course-commons-operating-model.md), [RFC 0004](rfc/0004-cross-institution-course-collaboration.md), independent [Open Course Standard](https://github.com/gmackie/open-course-standard).

**Work in review:** OCS PR #7 (experimental detached profiles); EducateOS PR #33 (persist installed local item IDs); PR #34 (teacher-only read-only update inspector, stacked on #33); EducateOS PR #31 (separate federated learner evidence design). Do not merge conceptual learner evidence into public curriculum packages.

## A. Decision and definition of success

Build a reusable **educational publication and collaboration network**, not a hosted central LMS and not a social network. A school can take a signed OCS course from another institution, lawfully adapt it, return a verified proposed improvement, and selectively adopt a publisher's revised release while preserving its own classroom and student records.

A complete first demonstration has eight independent, observable assertions:

1. Institution A publishes a syntactically valid, immutably pinned OCS course, approved under its policies, with subject-level attribution and appropriate redistribution rights.
2. Institution B independently verifies its publisher signature/digest and installs a local draft through its own permissions.
3. B retains its own OCS source-to-local item mapping, produces a local edition and modifies one lesson without changing A's publication.
4. B explicitly sends an authenticated proposal referring to exact immutable A and B versions, without student data or secrets.
5. A's authorized maintainer accepts or rejects the proposal in an auditable workflow; an accepted proposal yields a **new publisher-signed OCS release**, never an in-place edit.
6. B sees the new version and can review its differences, local edits and conflicts, with ambiguous legacy mappings visibly blocked.
7. B can choose to retain its current material, or activate an approved newly staged revision without rewriting history or changing previous submissions.
8. If the Foundation catalog, another institution or the original publisher disappears, B can continue using its already imported material in its own district account.

**Do not claim** 1EdTech certification, cross-LMS interoperability, FERPA compliance, live school readiness or educational learning gains merely because synthetic conformance tests pass. Record those evidence categories separately.

### Non-goals for first interoperable pilot

No national teacher social feed, teacher-to-teacher messaging platform, student-facing public collaboration, automated high-stakes grading, automatic AI acceptance, mandatory Foundation login, mandatory Clever or Google Classroom, remote classroom administration, global assessment bank, or centralized learner analytics.

## B. Current implementation and dependency graph

| Layer | Current source or PR | Known reality |
| --- | --- | --- |
| OCS content identity/lock | Independent OCS 1.1 spec and @educateos/ocs | Immutable packages, semver, digests, signed publishers, composition, activity exports and lockfiles |
| Standalone draft profiles | open-course-standard PR #7 | Experimental proposal/resource/revision helpers and tests; not normative |
| District course library | packages/educateos-district-app/src/course-library.ts | Imports approved signed bundles and stores immutable published versions; district pins publisher keys |
| Course installation | packages/educateos-district-app/src/course-install.ts | Add-only, resumable installs; no class upgrade; old title-based skip exists |
| Local install identities | EducateOS PR #33 | Adds recorded local page/module-item IDs for new imports, pending review |
| Update inspector | EducateOS PR #34 | Teacher-only preview; no apply; conservative reconciliation for missing mappings |
| Course Commons governance design | EducateOS PR #32, RFC 0004 | Design-only, not runtime authorization |
| Learner evidence | EducateOS PR #31, RFC 0003 | Distinct review; student data never published as OCS lesson material |

**Integration order:** stabilize PR #33 and the conformance/identity invariants, then PR #34 and read-only UI, then local editions, then staging/activation, then federated contribution inbox, then media/research extensions. OCS profile review is independent and can proceed concurrently.

Run OCS independent conformance against EducateOS's implementation (SCHO-348) before extending an accepted wire format. Experimental profiles may be implemented in adapters but must not silently change the OCS 1.1 parser, digest or signature bytes.

## C. Ownership, trust and identities

There are **four independent forms of identity**, never collapsed into a display title or an email:

1. **Publisher identity:** OCS domain/name + exact version + content digest + pinned signing key. Domain text alone is not proof of control. Local domains may have a district-specific unsigned policy, but this must not be mistaken for third-party attestation.
2. **Creative attribution:** human contributor identities, organizational rights holders, derived-from relationships and license notices. A signed package attests the publisher, not the original authors or ownership of embedded images.
3. **Installed source identity:** package ID/version/digest plus composed OCS unit key and item key, and the destination's local module/page/activity/assignment IDs. The original OCS structural key is not guaranteed to survive renaming across versions; missing matches are explicit reconciliation.
4. **Execution authority:** current institution-issued or federated verified subject, role and scoped policy decision on each action. Neither source metadata nor contributor-provided email claims authorizes publishing.

Store cross-version derivation as detached sidecars (e.g., compatible with W3C PROV-O), not inside OCS 1.1's strict file layout. Do not require Git. A Git repository or third-party authoring editor is a storage choice, not the protocol.

### Key decisions recommended now

- Adopt **publisher-assigned immutable OCS package identity**, with the receiving district maintaining its own mapping table. A later OCS version may add optional stable logical entry IDs after implementer feedback; do not guess equivalence from names.
- Represent contributions as **new candidate publications** pinned by digest; do not carry executable patch files.
- Separate an individual's staff/teaching identity from institutional **publish authority**. A contribution submitter is not implicitly authorized to sign a publisher release.
- Use publisher-approved keys for authenticity and a distinct delegated-auth mechanism for proposal submission/review. A proposal object is not an authentication token.
- Keep discovery opt-in and stateless with respect to student data; a recipient can pin and mirror any approved publisher independently.

## D. Data model: proposed domain records

These are logical contracts, **not presently accepted schemas**. Storage uses district-local durable records for installed and draft state, publisher-owned records for review, and portable signed content for releases.

### D1. Immutable package reference

Fields: packageId (domain/name), version, digest, and optional publication signature metadata. For one source entry: unitKey, itemKey and sourcePath, each pinned to that release. Resolve using the recipient's own trust and OCS package library, not untrusted network data.

### D2. InstalledSourceMapping

Fields: offeringId, packageRef, sourceEntryKey, destination moduleId, moduleItemId, pageId or activityId, original item content hash, local revision, installedBy, installedAt, and status: verified | legacy-ambiguous | missing | retired.

Rules: one installed source key maps to at most one currently active local item in a particular edition; multiple source mentions may legitimately resolve to one published portable activity definition. Preserve separate mapping for occurrences versus reusable definitions. If a title-only legacy import cannot be proven, mark it ambiguous and require teacher-assisted review. Never infer ownership from title.

PR #33 already adds useful page/module item mappings. The rest of this contract, including content hashes and migration, is future work.

### D3. LocalCourseEdition

Fields: editionId, offeringId, source package pin, local edition version/digest or immutable content snapshot, parent editionId, authorship/revision metadata, visibility (private | school | consortium | public), review status and createdAt. A local edition can use the upstream package unchanged except for explicit local adaptations. The source original remains available to compare.

The edition's classroom publication is local and policy-scoped; publishing an edition to a worldwide content catalog is a completely separate action.

### D4. ContributionProposal

Fields: proposalId (publisher-scoped), target package reference, candidate package reference, declaration of changed source paths, purpose, summary, submitter authorization and rights attestation identifiers, visibility, createdAt, and idempotency key.

States: draft -> submitted -> received -> screening -> under-review -> changes-requested | rejected | accepted. On acceptance, the authorized publisher MAY publish a new signed package; a review result is not itself a publication. Keep proposal comments/notes under publisher access policy, with separate scrubbed public summary when approved.

Replay: same proposal ID plus digest is idempotent; same ID with a different digest fails. A proposer must not be able to claim upstream review authority or submit outside approved collaboration relationships.

### D5. ReviewDecision and PublicationAttestation

Fields: proposal digest, decision revision, reviewer principal and organization (verified), scope of delegated approval, decision and reason, rights/subject/accessibility reviews, associated new signed publication if accepted, audit timestamp. Append-only history. Do not include credentials, student records, unreleased answer keys or copyrighted media bytes in event log.

### D6. ResourceArtifact

Fields: owner/publisher identity, media ID/version, SHA-256 of bytes, exact length, declared media type, claimed copyright holder, license and attribution, visibility/ACL, accessibility alternatives, and delivery locator or offline bundle descriptor.

An artifact manifest alone neither grants a license nor authenticates the publisher. Content Studio must validate actual media, size/decompression, scanning, egress policy, rights and local acceptance. Prefer Common Cartridge/Thin CC for existing delivery semantics; this OCS profile adds signed pins/provenance.

### D7. CourseUpdatePlan and Decision

Preview: offeringId, base/current/upstream exact pins, package dependency graph, per-source-item status, local revision, risk flags, changed standards/rubrics, missing mappings, affected classroom placements, and a preview digest.

Decision: chosen changes, plan digest, expected course-content/assignment revisions, principal authorization, current policy/rights checks, approval/decline and idempotency key. Re-evaluate privileges and revisions at activation; a stale preview cannot authorize a later write.

## E. Three distinct state machines

### E1. Publisher publication

Private draft -> editorial review -> rights/privacy/accessibility checks -> publisher approval -> signed immutable release -> distributed or indexed -> superseded or delisted.

Delisting a public index is not cryptographic deletion of an immutable artifact already mirrored, and does not revoke valid irrevocable open-license rights. Restricted/unreleased exams must never be placed into an openly distributed OCS bundle, even if their Codex visibility is teacher-only.

### E2. Contribution

Local adaptation -> proposed candidate -> identity/rights screening -> maintainer review -> acceptance/rejection/revision request -> **new publisher release if accepted** -> independently mirrored/consumed by recipients.

The sending institution and receiving publisher keep independent records. Approval at source cannot force a receiving classroom update.

### E3. Classroom adoption

Installed pinned edition -> discover a newer signed release -> **read-only preview** -> teacher chooses changes -> prepare new local draft/edition -> check reviewer and policy gates -> stage asset/activity mappings -> activation of the new classroom edition -> observe -> rollback pointer/selection if needed.

Initial preview must have no mutation. Decline or "not now" leaves the current edition intact. Existing grades, submissions and assignment versions remain as created; only future work may point at the new edition under institution policy.

## F. Update mechanics: the riskiest portion

**Do not promise a distributed transaction that existing district services cannot provide.** The current course-content and assessment services are distinct service/storage boundaries, and current course import is resumable and add-only.

### F1. Required engineering primitives

1. Immutable edition snapshot capturing source package, local course content, source-to-local mappings and the current approved classroom revision.
2. Stage all new content and portable activity definitions *without* student visibility and without changing active assignment bindings.
3. Validate every reference: publisher keys, OCS package hashes, media rights, school-approved CASE standards, lesson accessibility, restricted exam handling, current principal role and configured module/term policy.
4. Produce a teacher-readable impact report covering new pages, removed items, activity/rubric changes, active work, and local overrides.
5. **Activation boundary**: introduce one local durable pointer to the chosen active course edition, or an equivalent tested single offering-level transactional publication primitive. Until this is implemented, do not offer an apply button for multi-service changes.
6. Make activation compare-and-swap against expected current edition and policy revision. If any precondition changed, reject and request a new review.
7. Keep audit trail, immutable old material, previous local edition pointer, and recovery plan. A retry must be idempotent, not duplicate assignments.
8. For failures before activation, discard or quarantine staged drafts; failures after activation must allow exact pointer rollback, without deleting previously submitted work.

### F2. Classifications

- Upstream only, untouched locally: offered for explicit adoption.
- Local only: preserve.
- Upstream and local identical: informational, no new edit.
- Upstream and local competing changes: manual comparison and explicit selection.
- Source item removed: keep installed content and show an optional retirement path; never silently delete.
- New upstream item: optional new local draft.
- Local source mapping unknown or legacy title-matched: manual reconciliation, never auto-select.
- Teacher-only note, assessment, rubric, gradebook or interactive tool change: enhanced review with old version pinned.
- Standards assertion changed: verify publisher's alignment and recipient's approved CASE catalog; inferred equivalence is never authoritative.
- Dependencies of mixed versions conflict: fail preview/plan, not force a guessed module resolution.

### F3. Known limitation of PR #34

The current read-only inspector compares source units/items and local pages using recorded IDs, but **does not establish** that local assessment settings, student assignment bindings, rubric versions or every legacy import mapping are safe to migrate. Its "canApply: false" must remain true until the staging/activation design above passes tests. Treat the current inspector as situational awareness, not a proof that changes can be merged.

## G. Service interfaces: proposed, not deployed

### G1. Local district course API

| Operation | Caller and behavior |
| --- | --- |
| List library versions / available updates | Teacher authorized for an offering; local verified library data only |
| Preview version difference | Existing teacher.previewCourseUpdate from PR #34, no writes |
| Create local edition | Teacher/curriculum delegate; create private snapshot and attributable source mapping |
| Stage selected update | Teacher; issue immutable plan ID, expected revision, selected change paths |
| Validate and approve | Current authorized teacher and, where required, curriculum administrator; re-evaluate rights/standards |
| Activate staged edition | Institution service; CAS and idempotency key; no cross-district callback in critical path |
| Roll back edition pointer | Authorized teacher/admin; keep historical activity and grade pins |
| Publish an authorized reusable OCS package | Publisher delegate; separate rights/privacy release checks, not merely a classroom publish |

Route names and URL shapes are subject to the route table, Zod schemas, and policy vocabulary; do not implement a general unsafe course patch endpoint. Use per-offering resource scope and reject cross-offering or stale principals at every stage.

### G2. Optional publisher collaboration API

Proposed versioned HTTP resources:

- Publisher metadata discovery (publisher domain, supported collaboration-profile versions, public signing metadata; recipient must explicitly trust keys).
- Submit a contribution candidate by immutable publication reference with an authenticated principal and scoped capability.
- Read only proposals visible to that principal.
- Append review decisions with expected proposal revision.
- Retrieve verified publication result by exact ID/version/digest.
- Subscribe/poll for new signed releases without a mandatory Foundation service.

Define request/response schemas and authentication independently of OCS 1.1's core. Offer an offline/manual path (e.g., signed bundle plus emailed proposal manifest) so an institution need not run an internet-facing proposal API.

### G3. Optional catalog/discovery API

Index **publicly authorized** release metadata only: publisher, package ID/version/digest, title/description, subject, educational level, language, selected CASE alignments, license, available media formats, accessibility attributes, trust/review attestations, source provenance, and publishedAt.

Never ingest private course drafts, staff-only instructional notes, student identities, grades, assignment records or draft proposals by default. No global popularity score presented as educational effectiveness. Labels must distinguish human-reviewed standards alignment from machine-suggested similarity.

## H. User journeys and screens

### H1. Teacher: find and import

Discover -> inspect source/publisher -> review licensing, rights and standards -> preview what will install and what cannot transfer -> import local draft -> explicitly publish appropriate modules.

First-level UI vocabulary: "Use this", "See source", "Make my version", "Compare versions", "Suggest improvement". Keep Git internals hidden.

### H2. Teacher: inspect an update

An available-update row shows source and local version and a summary. Review has a side-by-side comparison of descriptions and safe snippets, distinct markers for local-only, source-only, conflicts and missing lineage, plus a warnings section for assessed/restricted items. Default action: **Keep current**. PR #34 has no apply action by design.

Later selected-change UI must show exactly what new publication would affect, and must never hide more serious blockers behind a cheerful success message.

### H3. Contributor: offer an improvement

Preflight: content ownership and institution sharing policy, selected contribution, attribution, rationale, safe diff and privacy scan. Choose target publisher and share scope, then explicitly submit. If offline, produce a bounded proposal package with no sensitive learner data.

### H4. Publisher maintainer: review inbox

Queue grouped by package, proposal kind, prior review context, signer trust and rights. Reviewer sees original/candidate differences, authorship and license assertions, comments, optional additional reviewers and accept/reject/request revision. Accepted work flows into a new signed publisher release, never an in-place mutation.

### H5. District administrator: trust and policy

Manage approved publisher domains/keys, allowed consortiums, publication permissions, staff-restricted content, import review, discovery opt-in and historical versions. Provide emergency publisher-key withdrawal without confusing it with the invalidation of already legally received educational content.

### H6. Foundation steward: public index and aggregate operations

Maintain public standards documentation, interoperability conformance reports, incident notices, optional catalog and program-grant evidence. Publish aggregated statistics with privacy protections; do not acquire district operational credentials or learner data.

## I. Standards fit and gaps

| Existing standard | Use it for | Do not claim |
| --- | --- | --- |
| OCS 1.1 | Immutable course structure, module composition, portable activity exports and exact versions | Social collaboration, execution authority, generic file transport |
| CASE 1.1 | Identifiers for competencies, framework associations and instructional resource tagging | Automatic cross-state equivalence or acceptance of credits |
| Common Cartridge / Thin CC | Established transport and LMS packaging of content/links/assets | Perfect retention of every OCS provenance or override |
| QTI | Portable assessment information, where compatible | Security of public answer keys |
| LTI 1.3/Advantage | Tool launch and LMS integration, controlled by each destination | Independent verification of all other aspects of OCS |
| W3C PROV-O | Reuseable provenance vocabulary for derivation and agent/author attribution | Proof of copyright ownership or an actual learning outcome |

As of November 2026, 1EdTech describes CC/Thin CC 1.4 as Candidate Final, not necessarily universally supported; select realistic external LMS compatibility tests and document losses. OCS 1.1 allows level-neutral course packages but portable activity exports still require K–12 gradeBand: a proposed future version should address higher-ed activities without introducing required grade levels in the core.

## J. Security, copyright, accessibility and privacy

### J1. Threats and controls

| Threat | Control and test |
| --- | --- |
| Spoofed author/publisher | Exact signed publication + independently verified reviewer identity; forged source refused |
| Tampered archive/mirror | SHA-256 and signature validation; altered bytes rejected |
| Embedded script/prompt injection | OCS strict JSON data-only; Content Studio scanning; text treated as untrusted data |
| PPTX/PDF parser exploit or archive bomb | Bounded isolated extraction, no macro execution, compression and nesting limits, malware/content checks |
| SSRF through media URL | Explicit authorized fetch, public-IP checks/redirect verification, allowlisted protocols, no render-time fetch |
| Student-identifiable data in resource | Prepublication privacy screen and human review; no learner data in public OCS / proposal |
| Teacher-only answer key exposed through public bundle | Never rely on UI-only visibility; keep restricted material outside openly downloadable package |
| Unauthorized upgrade after role change | Reauthorize at stage/approval/activation; fail closed after revocation |
| Lost local adaptation | Immutable base + local snapshots, explicit conflicts and reversible pointer |
| Reviewer override or counterfeit approval | Signed/audited decision, scoped institution role, no submitter-supplied principal |
| Rights escalation through composition | Existing OCS only-narrow rights ceiling plus destination license validation |
| Malicious or biased quality ranking | Publish provenance and review criteria; separate factual, instructional and accessibility review |
| Change during active assessment | Preserve old content and assignment/rubric pins; new content only for future explicit assignments |

### J2. FERPA/COPPA boundary

For U.S. schools, an external service that accesses education records under FERPA's school-official exception must be under the institution's direct control for those records and bound to appropriate use/redisclosure restrictions. The Course Commons should avoid receiving student records at all in the initial pilot. If eventual evaluation needs learner evidence, use a **separate** institution-authorized, reviewed research/data protocol, not public curriculum manifests.

Child users and guardians are not needed to prove educator-to-educator curriculum contributions. Start with fictional synthetic class records and opt-in adult educator review.

### J3. Accessibility

Design teacher screens to WCAG 2.2 AA targets; assess keyboard-only review, screen reader comparison descriptions, text alternatives for diagrams, plain-language conflict reasons, PDF/PPTX alternative formats, localization and right-to-left/language-level needs. Do not report compliance solely from automated tools. Keep an explicit human audit gate before external school pilot.

## K. Verification and CI matrix

### K1. Independent standard

OCS PR #7: keep separate normative schema, examples, conformance fixtures, accepted and rejected proposals, cryptographic verification and future profile versions. Test invalid publication digests, conflicting version claims, restricted content, invalid paths, no executable content, replayed proposals, no silent rights widening. Run Node 20, 22, 24 and cross-implementation comparison (SCHO-348).

### K2. EducateOS unit and route

- Source-to-local IDs: page/teacher-note/activity and portable definition mapping, replay and one-to-one occurrence identities.
- Two source items with the same visible title: never mistaken for the same item.
- Teacher edits page body: update preview reports conflict with upstream edit.
- New publisher item: optional, never installed by preview.
- Removed publisher item: old classroom material remains, possible retirement reported.
- Broken local mapping: reconciliation state, never guessing or auto-apply.
- Missing original installation, stale digest, reversed versions: reject.
- Teacher-only route: student/other-school teacher/guardian/guest refused.
- Invocation does not modify course installs, outline, assignments, grades or audit data except access/security events.

### K3. Workerd/durable stores

Restart during staged update; competing edits and CAS failures; partial writes and retries; role revocation mid-approval; root catalog outage; legacy install migration; large course data; one package included through a diamond graph; untrusted media and Content Studio quarantine. Validate actual transactional boundaries, not just in-memory fakes.

### K4. Independent institutions

Two separately configured accounts, trust anchors and distinct identities. Import valid signed package, refuse wrong publisher key, propose a correction, reviewer accepts/declines, republish immutable release, recipient previews and chooses. Simulate Foundation offline at every stage: already imported lessons should continue working. Provide independent non-EducateOS consumer acceptance before claiming broad standard interoperability.

### K5. End-to-end acceptance

Successful review flow must finish without developers editing JSON, Git commits or role permissions manually. One educator should be able to discover, inspect and propose in ordinary teacher language. Do moderated usability tests and record unsuccessful steps; avoid treating a developer-led demo as real adoption.

## L. Execution work packages

Effort ranges below are rough **engineering-weeks** (one engineer-week = ~one full-time engineer for one week). They are planning estimates, not verified task sizes; cross-team review and district agreements add calendar time.

| ID | Work package | Dependencies | Effort | Gate |
| --- | --- | --- | --- | --- |
| CC-00 | OCS spec parity, SCHO-348, PR #7 review + doc reconciliation | Independent OCS 1.1 | 1–2 | Existing 1.1 consumers still match normative conformance |
| CC-01 | Land source-to-local ID mapping PR #33; legacy mapping inventory | Existing course installs | 1–2 | No title-only false ownership; exact ID tests |
| CC-02 | Land read-only inspector PR #34; accessibility/authorization fixes | CC-01 | 1–2 | Teacher sees safe diff; no writes |
| CC-03 | Versioned LocalCourseEdition, snapshots and content hash baselines | CC-01 | 2–4 | Local edits persist; source unchanged |
| CC-04 | Review-grade compare/selection; assess rubrics, active assignments and rights | CC-02, CC-03 | 2–4 | Every conflict or unverified case is visible |
| CC-05 | Stage/activate/rollback local edition, durable recovery and policy rechecks | CC-03, CC-04 | 4–7 | No partial student-visible updates or historical grade mutations |
| CC-06 | Publisher trust metadata, local publish/sign pipeline and author attribution | CC-00 | 2–4 | Independently signed new releases verified by another school |
| CC-07 | Contribution inbox, signed review lifecycle, replay prevention and authorization | CC-06, PR #7 review | 4–7 | Accepted/rejected proposals and complete audit in two districts |
| CC-08 | Optional discovery index, course metadata search and CASE alignment provenance | CC-06 | 2–4 | School can operate without index; searched records source-verifiable |
| CC-09 | Portable resource manifest and vetted Common Cartridge media import/export | OCS media RFC and rights review | 3–6 | Licensed media travels safely; no unsafe parsing |
| CC-10 | Non-EducateOS adapter + external institution interoperability | CC-06, CC-07 | 3–5 | Independent producer/consumer completes roundtrip |
| CC-11 | Pilot readiness, accessibility/privacy/rights review and monitored teacher sessions | CC-02–CC-10 (scoped) | 2–4 | Independent reviewers sign off on the particular pilot workflow |

Do not simply add these maximal estimates: tasks can share foundations, but some are sequential. For one small integrated crew, an initial end-to-end synthetic workflow is an **estimated 12–20 calendar weeks**, depending on review scope and staffing; full interoperable media, signed collaboration protocol and real-school approvals can take longer. Re-estimate after CC-01/02 demonstrate complexity. A narrow teacher-only update prototype can ship to internal demo separately from the complete Foundation ecosystem.

### Recommended sprint grouping

**Sprint A — stabilize:** CC-00, CC-01, CC-02; reconcile current PRs and baseline tests.

**Sprint B — local editions:** CC-03; prototype course clones/immutable snapshots and explicit source item lineage.

**Sprint C — reviewed local upgrades:** CC-04 and CC-05; no public/student-visible activation until all safety gates pass.

**Sprint D — cross-publisher proposals:** CC-06/07; run two independent districts with fake publisher identities and rights-free original lesson content.

**Sprint E — interoperability and discovery:** CC-08/09/10; a second non-EducateOS implementation is especially important for demonstrating vendor neutrality.

**Sprint F — external pilots:** CC-11; authorized real educators, with non-student sample content first.

Keep each PR independently reviewable. Changes to OCS normative MUST/SHOULD, schema bytes, lock resolution or signatures require dedicated RFC, fixtures and changelog. Runtime features remain in EducateOS without assuming approval of an OCS extension.

## M. Pilot plan, recruitment and economics

### M1. Cohort

Initial invited design partners: two separate K–12 institutions plus one university instructional designer/teaching professor if available; 6–10 educators total with actual overlapping topics. Recruit a district curriculum admin and IT/security contact at each school. Start with fictional resource publishing and invented classes; only publish real teacher-owned or institution-authorized curriculum after written rights clearance.

Suggested curricular slice: shared watershed science / introductory scientific inquiry, from the OCS example. A university field lab contributes methodology, a K–12 teacher creates a low-cost adaptation, a second institution proposes a documented correction. This is a technical acceptance scenario, not yet evidence of learning impact.

### M2. Study method

1. Observe how participants currently share/copy lesson content (email, drive, LMS export, staff resource library).
2. Time a complete task without EducateOS as a baseline.
3. Guide participants through finding, reviewing rights, importing, adapting and proposing improvement.
4. Have a different publisher maintainer accept/reject and create a signed release.
5. Have recipient review update under simulated local conflicts and verify old student-like records are unchanged.
6. Record feedback, trust concerns, accessibility observations, licensing confusion, missing integrations and support time.
7. Repeat with reduced guidance. Report independent successful task completion, not just observed demo success.

### M3. Instrumentation

Events are aggregated, teacher/organization-scoped and district-approved. Track: time-to-find relevant content, verification failures, time-to-install, source-to-local mapping gaps, time-to-adapt, proposals created, review latency, outcomes accepted/rejected/changes-requested, update-conflict counts, time to resolve, successful rollback drills, import-media review failures and support minutes.

Public dashboards only show aggregated, sufficiently coarse statistics with an explicit minimum disclosure threshold; never send classroom rosters or identifiable students to Foundation analytics.

### M4. Hypotheses and gates

- Technical gate: **100%** of tested wrong-signature/digest/cross-offering attempts refused and **0** unintended student record exposure in controlled tests.
- Workflow gate: teachers complete share → adapt → propose using educator-language UI without developer tools.
- Reliability gate: loss of publisher discovery service does not break already installed lessons; staged updates recover from failure without partial student-visible publication.
- Economic gate: supported onboarding and review workload is measured, not inferred from Cloudflare compute prices.
- Educational gate: reviewers judge subject accuracy and instructional usability; actual learning effects require later study design rather than download-count proxies.

These are internal acceptance criteria and study hypotheses, not guaranteed numerical outcomes.

### M5. Illustrative pilot cash budget (excluding engineering salaries)

| Item | Planning range |
| --- | --- |
| 8 educator stipends for meetings/testing/review | $4,000–$8,000 |
| Subject/publisher and accessibility review | $2,000–$6,000 |
| Privacy, copyright and agreement review | $2,000–$8,000 |
| Facilitated research, travel, materials | $500–$2,000 |
| Cloud/model usage and test hosting | $200–$1,000 |
| Contingency | $1,000–$3,000 |
| **Cash total (illustrative)** | **$9,700–$28,000** |

Pricing is not quoted or negotiated; local legal/security needs can exceed this range. The largest omitted cost is engineering and operational support labor. A pilot cost model must account separately for these, recurring vendor licenses, LTI/LMS coordination, content review and Foundation staffing.

### M6. Fundable commons programs

- Curriculum correction and accessibility microgrants (maintainer and teacher time);
- Cross-institution standards alignment and open conformance test development;
- Licensing reviews and portable CC/OCS conversion tools;
- Shared public benefit evaluations, educator training and reusable authoring workflows;
- Subsidized integration support for resource-poor districts.

Never promise donors access to private student data or exclusive roadmap authority. A donor funds a capability or reviewed improvement, not ownership of all districts' use.

## N. Governance and sustainment

A publisher has editorial authority over its own releases. The receiving institution decides local acceptance. The Foundation maintains optional interoperability, public standards process and fiduciary oversight. Use an open technical steering group once multiple independent implementations exist; until then, do not claim a standards-body imprimatur.

Separate curriculum reviews into subject accuracy, instructional design, accessibility/rights and actual research evidence; avoid opaque popularity quality scores. Institution employees may not own material created in scope of work; publishing consent must be established with employer and any other rights holders, particularly university slides containing proprietary textbook figures.

Plan for a durable exit: mirror and export signed public artifacts, publisher-key rollover docs, independent builds, documented local restore and platform migration. A school's normal curriculum access must not depend on the Foundation continuing to operate.

## O. Risk register and stop conditions

| Risk | Impact | Mitigation or stop |
| --- | --- | --- |
| Teacher/time incentive weak | No ecosystem flywheel | Pay review stipends, design immediate private value, stop if independent educators cannot complete tasks |
| Legacy mapping guessed from titles | Wrong classroom update | Reconcile conservatively; no apply path for ambiguous source |
| Complex multi-store mutation | Partially published assignments | Stage immutable revisions and validate tested activation boundary before launch |
| Copyright clearance unclear | Unauthorized redistribution | Keep material private; no public release without institutional/rights sign-off |
| Teacher-only item in public OCS bundle | Assessment leakage | Explicit restricted distribution model; block open publication |
| Spec expands into an LMS | Adoption barrier | Keep collaboration sidecars, runtime outside OCS and independent conformance |
| One Foundation catalog becomes mandatory | Vendor lock-in | Offline import, publisher mirroring and recipient trust pins |
| AI-generated content degrades accuracy | Misleading learning materials | Named human reviewers and separate quality dimensions |
| Standards alignment mistaken for equivalence | False curricular claims | Distinguish direct CASE alignments, reviewed mappings and suggestions |
| Another institution declines contribution | Poor collaboration experience | Continue local edition rights; provide respectful review reasons |
| No external implementer | Standard remains product-specific | Prioritize non-EducateOS reference consumer before "interoperable" marketing |

**Stop or narrow the pilot** if a rights review cannot clear sample materials, source identities cannot be reliably preserved, grades/assessments could be silently affected, or public collection of student records becomes necessary to demonstrate the workflow.

## P. Immediate, ordered next work

1. Review/resolve PR #33 and #34 dependency and CI health, distinguishing core tests from repository CLA/upstream policy gates.
2. Complete SCHO-348 conformance parity and decide which OCS PR #7 profiles remain detached.
3. Prototype a local edition immutable baseline + item mapping migration without changing active classes.
4. Write failure-injection tests for any staging/activation design before shipping apply semantics.
5. Define a minimal publisher collaboration API, signed publication and rights-review attestation.
6. Build one actual accepted and one rejected change proposal between two synthetic districts; only then add discovery automation.
7. Recruit independent teacher maintainers and an external LMS implementer; evaluate a privacy- and rights-cleared science lesson.
8. Record benchmarks, support time and reviewer effort, and update the Foundation's microgrant/business model from those measurements.

**Next architectural decision:** whether to build an offering-level active-edition pointer (recommended) or a transactional module-release table. Make that choice explicitly before implementing any upgrade endpoint because it controls idempotency, rollback and protection of past student work.
