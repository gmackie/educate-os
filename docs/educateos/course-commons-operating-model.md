# EducateOS Course Commons — operating model and delivery blueprint

**Status:** Working design, November 15, 2026. No interoperability, legal, licensing, or live school-pilot approval is implied.

**Related implementation:** independent OCS PR #7 (draft profiles), EducateOS PR #33 (durable local item mappings), PR #34 (read-only teacher update inspector, stacked on #33), and EducateOS RFC 0004 (PR #32). This document elaborates operating behavior and review gates, not an alternative normative specification.

**Detailed implementation:** [Technical delivery and pilot program](course-commons-technical-delivery-plan.md), including versioned data contracts, update activation safeguards and acceptance tests.

## 1. Purpose: curriculum as a maintained scholarly artifact

University professors routinely exchange lectures, slides and problem sets. K-12 teachers share lessons and adapt materials to local needs. Those exchanges are useful, but improvements often remain disconnected from their source. The Course Commons should let teachers and professors:

1. Discover a vetted resource using a learning objective, subject, language or pedagogical context.
2. Bring it into their own independently controlled institution.
3. Adapt it without changing anyone else's original.
4. Propose a correction or improvement to the original maintainer.
5. Review, discuss, revise, accept or reject that contribution.
6. Optionally adopt upstream improvements without losing local modifications or changing work already submitted by students.

**Make instructional knowledge cumulative without making teaching uniform.**

The public good is the maintained body of lessons, explanations, activities, assessments, documented adaptations and attribution—not the number of files uploaded or students interacting with AI.

## 2. Institutions, roles and authority

An organization can be simultaneously a contributor, publisher, reviewer and consumer. Those are *roles*, not a mandatory central account or a shared administrative superuser.

| Actor | Controls | Cannot unilaterally do |
| --- | --- | --- |
| Teacher / professor | Local drafts, authorized local editions, proposals, reviewed classroom adoption | Publish another institution's official release |
| School or district | Local course library, classrooms, student data, identity, publishing permissions, allowed providers | Revoke an already valid open license for copies legally received |
| Maintainer | Review queue and what to incorporate into the publisher's next release | Rewrite or remove another institution's local edition |
| Publisher | Package identity, signed immutable versions, publishing keys, public/restricted distribution choices | Force-install content in a recipient institution |
| Discovery provider | Search/index authorized publication metadata | Sign for publishers or override recipient trust policy |
| Foundation | Standard stewardship, optional discovery, microgrants, community review, shared assurance | Become the only runtime, gatekeep identity, extract student records or set district curriculum |
| Implementation partner | Optional setup, training and integration support under district contract | Gain access to student data or policy keys by Foundation participation alone |

A verified publisher signature proves source identity and content bytes, **not** copyright ownership, a human educator's identity, factual quality or legal permission to redistribute.

## 3. Domain model and three distinct graphs

**Immutable course graph:** OCS 1.1 package IDs, versions, SHA-256 digests, signed publishers, composition and resolved lockfile. Its source item keys are structural, not names chosen by an instructor.

**Creative derivation graph:** Separate records link a published source unit, its local adaptation, a proposed contribution, its reviewer, and a later accepted new release. Use W3C PROV-O concepts (Entity, Activity, Agent, wasDerivedFrom, wasAttributedTo) where useful. Do not make the OCS core dependent on a specific social protocol or identity provider.

**Institutional usage graph:** A school's local installed module, page, activity, assignment and approved material each have local IDs and revisions. This graph remains in the school's deployment, beside rosters, assessment data and grades. A portable OCS course must not include learner records.

### Candidate stable records (not yet deployed)

* SourceRef: publisherScopedPackageId, exactVersion, packageDigest and OCS unit/item key. A title is never an identifier.
* LocalEdition: local publisher ID/version/digest, source parent ref, optional adaptation rationale, visibility, author's institution and release state.
* InstalledSourceItem: source ref, offering ID, local module/item/page/assignment mapping, original-content digest, installed-by and installed-at; ambiguous preexisting matches are flagged.
* ContributionProposal: proposal identifier, exact source and candidate package refs, declared changed paths, purpose, rights attestations and optional evidence pointers.
* ReviewDecision: proposal digest, reviewer identity and institution-scope authority proof, reason, status, revision and audit metadata. A review does not itself constitute new publication.
* PublishedResource: detached media ref, bytes digest/length/type, verified publisher, asserted license and provenance, accessibility assets and local resource mapping.
* ClassroomUpdatePreview: base, local and upstream identities, per-item statuses, unverified areas, teacher-facing explanation, and explicit no-write flag.
* ClassroomUpdateDecision: frozen update preview digest, reviewer-selected changes, auth/policy/rights/standards validation, new local revision and rollback marker.

Do not add these records as unknown fields in OCS 1.1's strict manifest or as extra files in an OCS 1.1 package. They belong to opt-in profiles or institution-controlled runtime stores, pending independent-standard RFC review.

## 4. Content publication and rights review

Suggested authoring statuses:

Private draft → Internal review → Rights and privacy cleared → Publisher-signed immutable release → Indexed or privately distributed.

A school may keep material entirely local. A *consortium* release may be accessible only to members. A *public* release requires an explicit authorized act and a reusable license where appropriate.

Rights checks must distinguish:

* Work the author/institution owns outright.
* Licensed third-party works that allow classroom use but not redistribution.
* Openly licensed components whose attribution and share-alike rules must survive adaptation.
* Instructor guidance suitable for public reuse.
* Restricted exams or answer keys that cannot be safely distributed as plaintext in a public bundle.

OCS teacher-only display restrictions do not encrypt publicly downloadable bundles. Sensitive assessments require separate access-controlled distribution and a threat model for leakage. Automated checks can help detect common problems but cannot establish ownership by themselves.

The receiving district confirms all dependencies and licenses at import time; a source publisher's assertion is not a blanket rights grant.

## 5. One complete collaboration journey

### Scenario: a Michigan science teacher and a Texas educator

1. A Michigan publisher signs an OCS package containing a photosynthesis unit. It includes a licensed PDF diagram and a portable activity, with explicit provenance.
2. A Texas teacher finds the unit by subject and reviewed CASE alignment in an optional catalog. The catalog provides discovery only; the Texas district verifies the publisher's signature against its own trust policy.
3. The Texas teacher imports a local copy and replaces an equipment-heavy demonstration with a low-cost alternative. Her institution retains the local course revision and mapped item IDs. Nothing upstream changes.
4. After repeated classroom use, the teacher identifies a factual ambiguity and submits a *proposed improvement* to the Michigan publisher. The proposal names the exact starting package digest, candidate digest and changed paths; it contains no student work or grades.
5. A Michigan maintainer reviews the new explanation, license, accessibility and supporting rationale. The proposal may be rejected, accepted, or returned for revision.
6. If accepted, the maintainer publishes and signs a new immutable version. The Texas teacher receives an optional update notification without requiring a national EducateOS account.
7. A read-only comparison shows local vs upstream changes. The teacher may keep local modifications, select a compatible change or decline the update. The current version of assignments and prior submissions remains pinned.
8. The system records appropriate attribution for the Michigan original, the Texas contribution and future changes, without making popularity equal instructional evidence.

This same workflow should work when the source publisher is a university that uses Moodle or Canvas, even if the recipient uses EducateOS. The first non-EducateOS adopter should be a meaningful interoperability objective.

## 6. Teacher experience: five surfaces, not a developer forge

* **Find materials:** search by learning objective, subject, age/level, language, modality, accessibility, license, author, publication and reviewer evidence. Label direct CASE alignment vs suggested semantic similarity.
* **Use in my class:** verify trusted publisher, show material and known losses in imported format, explain what stays local, create drafts only, require teacher to publish.
* **My adaptation:** clearly show which parts are inherited and what the teacher has changed; retain a local independent edition.
* **Offer an improvement:** an educator-friendly difference view, attribution preview, rights review, summary/rationale, select upstream maintainer, submit only with permission.
* **Review updates:** source version, installed version, changes from publisher, local edits, conflicts, unverified items, teacher-only and assessment risk. Default action is **keep current version**. Future apply requires a separately reviewed transaction and is never bundled into a preview button.

Never expose Git commits, force-push, rebases or merge conflicts as required teacher actions. More advanced maintainers may choose developer tooling behind these interfaces.

## 7. Proposed federation mechanics

Start with a simple opt-in federation, not general-purpose peer-to-peer networking.

### Publication plane

Publishers serve signed, immutable OCS packages and optional CC archives or detached media artifacts through controlled HTTPS or offline bundles. A publisher identity is scoped to its domain and approved public key. Public discovery metadata can point to versioned artifacts without becoming the source of trust. Mirrors may be used if rights allow.

### Collaboration plane

Optional institutions maintain a **contribution inbox** and authenticated outbound proposal channel. A receiving publisher authenticates the sending service and verifies the claimed contributor is authorized under the origin institution's policy. Reviewer actions append an auditable decision. The issuer's key and the individual's educational role are separate assertions.

Open protocols should allow HTTP-based exchange and signed records without assuming a global EducateOS account; future ActivityPub-style notifications are optional and should be evaluated against actual use.

### Classroom plane

All OCS imports are converted into district-local drafts by the existing course library and Content Studio. Only local policy authorizes publication, assessment use and update decisions. An unavailable Foundation discovery service must not break ordinary teaching, access to already imported content, or student work.

## 8. Portability: reuse existing education standards

OCS is a content-composition, version-pinning and trust contract. It should integrate rather than compete with:

* **CASE:** framework and competency references; cross-framework associations must report source and review status.
* **Common Cartridge/Thin CC 1.4:** transport course content/assets, LMS interoperability metadata and QTI/LTI references. Prefer its existing file packaging where it preserves meaning; report loss if it does not.
* **QTI:** interoperable assessments, subject to local security and item-banking policy.
* **LTI 1.3/Advantage:** tool launches and gradebook integrations, with local institution-owned keys and launch policy.
* **W3C PROV-O:** conceptual provenance and attribution links.
* **OER licenses:** separately enforce copyright and redistribution rights; a module's OCS rights ceiling is not a copyright license.

A detached media profile is useful for immutable media IDs, digests, provenance, accessibility alternatives and receiving-district verification. It is not an excuse to put arbitrary executable binaries in OCS's data-only package layout.

## 9. Safety and correctness invariants

1. Publisher signatures and package hashes verified by the receiving institution.
2. No proposed change implies access to another school or authority to publish on its behalf.
3. No student data, grades, unreleased assessments, secrets or private identifiers in public collaboration records or mirrors.
4. Source items must be matched through exact lineage, not title similarity. Missing mapping means manual reconciliation.
5. Local teacher additions and modifications must not be erased silently.
6. Changed rubrics, scored assignments, term rules and standards alignment require dedicated review.
7. No active assignment or historical submission changes its pinned version through an update.
8. Proposals and reviews remain usable without a central Foundation service.
9. Every change that becomes a published OCS release creates a new immutable version.
10. License and attribution checks run again on adaptation/export, not only at the first publication.
11. Publishers cannot revoke rights already granted through a valid irrevocable public license merely by hiding an index listing.
12. AI summaries and proposed merges are untrusted assistance, not publisher approval or evidence of pedagogical effectiveness.

## 10. Build order and explicit acceptance

### Phase 0 — Evidence and parity

Finish independent OCS 1.1 conformance against EducateOS's implementation (SCHO-348). Review OCS PR #7 without promoting its detached experimental profiles to stable semantics prematurely.

### Phase 1 — Local source mapping

PR #33 adds local IDs to pages, teacher notes and placed activities. Its test must prove each installed source OCS key maps to exactly one owned local item. Old title-skipped imports remain unresolved unless independently verified.

**Gate:** no false source matches; tests for missing/duplicated/renamed local items, and successful retry of a partially recorded activity placement.

### Phase 2 — Read-only version inspection

PR #34 adds an explicitly authorized preview of a newer imported version. It must refuse absent base/candidate, incomplete installs, changed digest, cross-offering access, and source identity confusion; it reports local edits and competing changes without student data or a write path.

**Gate:** a teacher can identify upstream changes and local conflicts in the UI; before/after classroom records are bitwise equal; no update operation exists.

### Phase 3 — Approved local editions and controlled upgrades

Create an immutable local edition record and version-aware item mapping. Stage a selected-change plan, approvals and future update decision. Define how content pages are cloned, how assessments and rubrics are separately versioned, and how a transaction is rolled back.

**Gate:** explicit teacher selection, policy revocation mid-review, idempotent apply, interrupted transaction recovery, historic-grade/submission pinning and rollback tests.

### Phase 4 — Cross-institution proposals

Create permission-gated collaboration inbox, outbound proposals, review events, signed publication handoff and optional discovery. Initially exchange approved OCS content and feedback across **two independently operated organizations** with fake identities/content, then pilot authorized real educators.

**Gate:** one accepted correction and one rejected correction; no unauthorized publication, no central dependency and complete attribution.

### Phase 5 — Rich-media reuse

Add signed portable references and vetted CC-transported assets; receive PDF/PPTX through safely bounded inspection and a local Content Studio release. Handle inaccessible/unauthorized material visibly rather than silently omitting it.

**Gate:** an independently published, genuinely reusable PPTX/PDF survives export/import, rights and attribution, source verification and accessibility review.

## 11. Foundation programs enabled by this network

* **Shared interoperability:** maintain cross-platform OCS and Common Cartridge adapters, open test suites and publisher trust guidance.
* **Curriculum microgrants:** support teacher time for reviewed corrections, accessibility improvements, language adaptations and otherwise unfinanced instructional needs.
* **Publisher communities:** maintainers, schools, universities, education researchers and accessibility reviewers with open conflict-of-interest policies.
* **Evidence and research:** publish structured reviews and methodologically appropriate evaluations, never infer student learning from download counts.
* **Optional infrastructure:** discovery catalogs, mirrors, signing-tool docs, incident reporting and outreach. No monopoly on these services.

Avoid making a Foundation-operated discovery catalog the prerequisite for participating; a valid course and a compatible consumer should be enough.

## 12. Pilot economics and success metrics

Run an initial cross-institution design pilot with 6–10 teachers, two independent school deployments and, if available, one university educator using a different LMS. Budget for educator review time rather than only cloud costs. Do not use real student work for the first technical interoperability exercise.

Measure time to locate, understand, legally reuse and adapt a course; percentage of contributions needing rights clarification; review time; accepted/rejected contributions; inaccessible content; stale/ambiguous source mappings; rate of repeat reuse; and support minutes per participating institution.

Educational effect must be evaluated separately with appropriate study design. A resource reused many times may still be inaccurate or ineffective.

## 13. Design decisions still open

1. Whether OCS item keys need a stable cross-version identity separate from path.
2. Whether a publisher can delegate reviews without delegating signing authority.
3. How copyright coauthors and institutional rights holders are represented and attested.
4. How and where to store restricted assessment packages with authenticated educator access.
5. Whether every accepted upstream proposal creates a new course version or a smaller independent module version.
6. How to represent an edition's dependency on a concept aligned to multiple CASE frameworks without asserting equivalence.
7. Which alternative to a Foundation-run discovery service will be used in the first external interoperability test.
8. What constitutes a complete "upgrade": course structure only, newly created assignments, or all current classroom content. This must be scoped before an apply API is built.

## External standards references

- 1EdTech Common Cartridge: https://www.1edtech.org/standards/cc
- Open edX Content Libraries: https://docs.openedx.org/en/latest/educators/concepts/instructional_design/content_libraries.html
- W3C PROV-O: https://www.w3.org/TR/prov-o/
- Independent OCS 1.1: https://github.com/gmackie/open-course-standard/blob/main/spec/ocs-1.1.md
