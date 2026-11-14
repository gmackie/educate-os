# RFC 0003: Federated Learning, Local Authority, and Portable Evidence

**Status:** Proposed (design only; not an implementation or certification claim)  
**Date:** 2026-11-14  
**Owners:** EducateOS maintainers and adopting institutions  
**Scope:** District-local curriculum alignment, learning opportunities, assessment claims, institutional acceptance, and authorized portability  
**Related:** ADR-0001, ADR-0004, ADR-0005, ADR-0011 (open-source charter), ADR-0012, ADR-0013/0014, RFC 0001 (OCS), RFC 0002 (Integration Fabric), P01/P02 portability, E01/E02/E03 assessment  
**Issue:** To be assigned

## 0. Decision and thesis

**Centralize the guarantees; federate the decisions; share evidence, not control.**

EducateOS permits independently governed states, districts, schools, educators, families, and students to pursue different educational methods while using inspectable contracts for standards, teaching opportunities, assessments, and learner-record exchange.

A district may adopt a published standards framework, fork an activity, reject a proposed crosswalk, and apply its own assessment policy without asking an EducateOS-operated service for permission. A student may pursue an interest-led project, encounter a relevant standard, demonstrate learning, and carry appropriately authorized evidence to another institution. The receiving institution decides whether the evidence fulfills *its* obligations. No central operator can decree equivalence or award local credit.

The central EducateOS website may distribute signed software, public curriculum packs, mapping proposals, or optional marketplace items. It is not a runtime education-record processor, the source of student identity, a national academic authority, or a mandatory dependency for classroom operation.

**This RFC proposes the missing policy and orchestration boundary.** It does not reimplement the existing registry, catalog, configuration compiler, course specification, assessment pipeline, or portable learner archive.

### Decision summary

| Question | Decision |
| --- | --- |
| Who defines academic standards? | The actual publisher or lawful authority; preserve its text, identifier, version, and provenance. |
| Who adopts them? | The locally authorized institution, using its district-local approved catalog. |
| Who maps one framework to another? | Independent publishers/reviewers may propose maps; adopting institutions decide which mappings to trust. |
| Can AI assert that two standards are exactly equivalent? | No. AI-only evidence cannot establish an exact relationship. |
| Who designs a lesson? | Educators, communities, students and approved assistants, within applicable policy and curriculum obligations. |
| What makes student work educational evidence? | A versioned evidence contract, a bound artifact or assessment, known assistance conditions, and a reviewable decision. |
| Who awards credit or official grades? | The designated local authority; never an unreviewed AI proposal or crosswalk. |
| Does transfer imply recognition? | No. Export, verification, comparison, and acceptance are separate operations. |
| Where are student records kept? | In the district account or an explicitly approved provider; not in a global EducateOS learner graph. |
| Can a guardian write learning invitations today? | No; ADR-0012 presently makes guardians read-only. A future permission must be deliberately scoped and implemented. |

## 1. Problem

American K-12 education is structurally decentralized. Requirements and constraints differ by state and institution, while teachers, families, and students have legitimate reasons to use different learning approaches. Making every district use an identical curriculum or assessment procedure would erase valuable autonomy. Doing nothing yields incompatible records, opaque claims of mastery, repetitive re-assessment, and weak opportunities to share useful teaching resources.

Three things are frequently confused:

1. **Interoperability:** Can two systems exchange a standards reference, activity, rubric, or evidence record without losing meaning?
2. **Semantic alignment:** Do two requirements or claims genuinely mean the same thing, partially overlap, or merely sound similar?
3. **Institutional acceptance:** Does the institution responsible for the learner decide that this evidence satisfies its rules?

Correct technical exchange does not prove semantic equivalence. Semantic equivalence does not compel institutional acceptance. A polished working artifact does not prove independent student mastery.

A related product challenge is personalized education. A learner might ask to build a Roblox experience, analyze sports statistics, write music, or start a garden. EducateOS should find authentic teaching opportunities within the activity, drawing from teacher-approved objectives, prior demonstrated knowledge, student choice, and optional family invitations. But a system that only chases interests will miss mandated material; a system that forcibly converts every interest into an assignment will destroy autonomy.

## 2. Goals and non-goals

### Goals

- Preserve source-owned standards, independent local authority, and explicit trust decisions.
- Reuse the existing CASE-backed registry, district-approved catalog, OCS packages, assessment evidence contracts, grade gates, and P01/P02 transfers.
- Support interest-first and standards-first planning with the same evidence vocabulary.
- Separate observed activity, proposed alignment, demonstrated proficiency, official grades, and transferred evidence.
- Permit reviewed crosswalks and explicit, versioned local acceptance policies without a global equivalence table.
- Enable independent institutions to reuse public curriculum techniques without sharing identifiable student records.
- Retain evidence provenance, source/assistance conditions, rights, version history, and review decisions.
- Make institutional disagreement visible and manageable rather than silently treating it as a software error.
- Prove district isolation, offline/root independence, and approval boundaries in the synthetic harness.

### Non-goals

- A single national curriculum, mandated learning sequence, ranking of children/teachers/districts, or EducateOS-issued accreditation.
- Automated assignment of official grades or transferred credits.
- Continuous monitoring or behavioral profiling of minors, or optimization for session length.
- A global learner identifier, cross-district searchable profile, or default cross-district analytics feed.
- Replacing CASE, CLR, OCS, LMS source-of-record decisions, or the current EducateOS policy engine.
- Requiring Roblox or any other third-party project environment for educational participation.
- A claim of CASE, CLR, or LTI certification on the basis of locally passing tests.
- A guarantee that interest-based teaching alone covers all required foundational skills.

## 3. Repo baseline: extend, do not duplicate

The source of truth for the existing implementation is the repository code and the capability maturity ledger. A specification-shaped package is not proof of deployment or external conformance.

| Existing capability | Reuse | Extension proposed by this RFC |
| --- | --- | --- |
| **@educateos/registry**: FrameworkDefinition, CompetencyNode, CompetencyAssociation, EvidenceContract, strict CASE 1.1 codecs | Original standards identifiers, source provenance, reviewed associations, observable criteria and assistance restrictions | Local approval of which proposed associations are *usable for which purpose*, plus evidence-claim references |
| **@educateos/catalog**: approved immutable releases, local overlays, framework coverage | District selection, versions, per-grade available-text reporting | Separate teaching, assessment, and mastery coverage views; do not reinterpret current framework coverage |
| **@educateos/curriculum / @educateos/ocs**: versioned activities, AI-help rules, signed composable courses | Teacher/author-owned content and reproducible published packages | Reusable learning-opportunity plans and invitations as district-local instances, linked to approved releases |
| **@educateos/assessment / assessment-ci / assessment-ai**: pinned submissions, evaluator releases, teacher-approved grades | Existing evidence snapshots and human approval gate | Evidence-to-competency decisions; preserve evaluator output as *suggested* until authorized review |
| **@educateos/portability**: deterministic learner archive, consent, signed transfer, CLR seam | Bounded export, source/destination verification, pseudonymous cross-district handoff | Optional, separately versioned competence-evidence payload subject to rights, source and destination policies |
| **@educateos/config / policy**: immutable revisions, monotonic protective floors, default-deny ABAC | Authorization and privacy enforcement | Scoped authority for mapping review, teaching invitations, and local acceptance decisions |
| **@educateos/fixtures / harness / pilot-gate** | Six isolated synthetic districts and failure injection | End-to-end federation invariants and a transfer/acceptance test matrix |

Relevant source:
- [Registry associations](../../packages/educateos-registry/src/framework.ts)
- [Evidence contracts](../../packages/educateos-registry/src/evidence-contract.ts)
- [Catalog mirror](../../packages/educateos-catalog/src/mirror.ts)
- [Assessment](../../packages/educateos-assessment/src/model.ts)
- [Portability consent](../../packages/educateos-portability/src/consent.ts)
- [Curriculum authoring](../../../curriculum/README.md)
- [Capability maturity](../maturity.md)

**Current limitations material to this RFC:** the catalog coverage report describes framework availability, not learning mastery; a general evidence-acceptance workflow is not established by the existing teacher-approved grade gate; guardian writes and personal-conversation access remain denied under ADR-0012; and a CLR export seam should not be described as certified CLR interoperability.

## 4. Authority model

### 4.1 Responsibilities, not a forced hierarchy

Authority is derived from law, adopted institutional policy, authorized human roles, and the relevant education record's actual source of record. EducateOS does not claim that all states or schools have identical governance structures.

| Role | May author / decide | Cannot do merely by this role |
| --- | --- | --- |
| Standards publisher / relevant state authority | Publish and version its standards and official mappings | Change a district's local assessment record |
| District curriculum administrator | Select approved releases; approve or decline local crosswalk use; set curriculum requirements | Override legal obligations or access student-private conversations by default |
| School leader / teacher | Choose lawful instructional approaches; author activities; review assessed work where authorized | Relax a district protective floor or automatically award transferred credit |
| Student | Choose personal projects, propose goals, accept/defer optional invitations, demonstrate skills | Convert a self-assertion into an official grade |
| Guardian | See permitted education information through a confirmed relationship; suggest optional topics **only after an explicit new capability is implemented** | Read private conversations, alter official records, or act through an unverified relationship |
| EducateOS/marketplace publisher | Publish signed, versioned standards references and reusable resources | Impose district policy, access student records, confer academic credit, or require live root access |

### 4.2 Types of controls must remain distinct

- **Nonnegotiable protections:** legal/privacy requirements, authorization, record integrity, local configured budget ceilings. Resolve through existing policy floors, district to school to offering to activity, with child scopes only tightening supported protections.
- **Institutional obligations:** which standards and assessments must be covered, assessment windows, school calendar. These are local academic settings; they do not become arbitrary global runtime policy floors.
- **Professional judgments:** teaching methods, classroom routines, examples, rubrics where locally delegated. These are contextual choices, not always ordered from stricter to weaker.
- **Personal choices:** learner interests, projects, optional explorations, and age-appropriate customization. They are revisable and should not become sensitive behavioral profiles.

The policy engine must not conflate “the teacher used a different instructional approach” with “the teacher weakened a student-safety rule.”

### 4.3 Authority provenance

A local acceptance decision must record *why that actor had authority* at the time, referring to a trusted, district-resolved role or approval, not an asserted prompt role, email address, external claim, or agent metadata. Enforce the existing policy vocabulary, dates, and source-of-record controls. Do not let an AI tool impersonate a reviewer or supply review stamps.

## 5. Four distinct record classes

This RFC recommends four *conceptual* contracts. Schema placement and identifiers will be settled in implementation work; these are not declarations of already-existing APIs.

### 5.1 LearningOpportunity

A candidate intersection between a learner's current intent and a locally approved competency. It is **not** a claim of mastery.

Recommended fields:
- District-local owner and scope; activity/project reference; approved framework release digest and competency URI.
- Origin: student intent, teacher-selected objective, district requirement, or authorized guardian invitation.
- Why this concept matters *now* to the student's present task; prior knowledge used; prerequisites; alternate activities.
- Proposed explanation, learner task, observable criteria, and independent check; accessibility/language requirements.
- Classification: required, recommended, or optional; student-visible disclosure of the educational reason.
- State: proposed, eligible, shown, accepted, deferred, declined, implemented, assessed, expired; change history.
- Planning model/version and teacher review where required; no covert personality scores or hidden coercive targeting.

A plan may recommend an activity but must not secretly publish an assignment or broaden the district's AI-help permission.

### 5.2 CompetencyEvidenceClaim

One narrowly scoped assertion that an identified learner's performance supports an identified competency. It is not automatically a grade or credential.

Required conceptual fields:
- **Subject:** district-scoped learner reference; never a global student ID.
- **Target:** competency URI, framework release/digest, and local adopted framework version.
- **Evidence:** immutable artifact/submission revision or assessment run with digest; evidence contract ID and version; rubric and evaluator versions where present; provenance and source checkpoints.
- **Conditions:** level and disclosure of AI assistance, collaboration, accommodation or assessment conditions where justified and permissible; observed versus independently demonstrated work; time of the activity and assessment.
- **Issuer:** responsible institution plus authorized reviewer (when reviewed), signed/recorded decision and policy version.
- **Decision:** proposal, reviewed-supported, reviewed-not-supported, or superseded; reasons anchored to evidence criteria.
- **Rights and visibility:** permitted student/teacher/guardian access, retention, export and transfer rules.

The claim MUST NOT assert independent mastery if a model produced the demonstrated work, if provenance is missing, or if a required independent check was not satisfied.

### 5.3 MappingAcceptance

An institution's decision about whether a cross-framework association may be used for a particular purpose. It references an existing immutable CompetencyAssociation, rather than rewriting CASE material.

Suggested inputs:
- Original origin/destination identifiers and their exact releases.
- Original relation (exact, close, partial, broader, narrower, prerequisite, etc.) and evidence/provenance.
- Local purpose: discovery, curricular planning, evidence pre-screening, or transfer review.
- Reviewer's identity, local scope, decision, rationale, approved date, expiry/review date, source digest.
- Explicit consequences and *non*-consequences. Mapping approval alone never issues a grade.

A review can be withdrawn while retaining the historical reason earlier recommendations were made.

### 5.4 EvidenceAcceptanceDecision

A receiving institution's independent judgment about submitted evidence, addressed to **its own** applicable competency and requirements.

- References a source claim/record and locally verified transfer/import receipt.
- Points to a local target standard, framework release, required rubric, and policy revision.
- Records source authenticity, permissions/rights check, semantic mapping strength, remaining gaps, and requested supplemental assessments.
- Status: pending-review, insufficient-evidence, accepted-for-local-competency, rejected, or revoked/superseded.
- Records the authorized human review. A separate official grade or credit action must still go through the institution's existing grade authority.
- Never reuses source district principal IDs as receiving principal IDs.

These four records allow the system to say **“relevant evidence exists but has not been accepted here”** rather than incorrectly displaying a universal mastery percentage.

## 6. The evidence lifecycle

~~~text
Student goal / teacher requirement / optional invitation
    |
    v
Locally eligible LearningOpportunity
    |   show why, preserve student choice
    v
Activity + artifact / observation / assessment
    |
    v
Versioned evidence contract + immutable provenance
    |
    v
Assessment suggestion (automated or human)
    |
    v
Authorized local evidence review
    |
    +----> CompetencyEvidenceClaim: supported / not supported
    |                              |
    |                              +--> optional, scoped transfer
    |                                     |
    |                                     v
    |                              Destination verifies package,
    |                              consent, source and rights
    |                                     |
    |                                     v
    |                              Destination independently
    |                              applies its acceptance rules
    |
    +----> separately authorized official grade or credit
~~~

**Do not conflate:**
- A student encountered a topic, versus practiced it.
- A project passed automated tests, versus the student independently understood the code.
- An AI assessment proposed a score, versus a teacher accepted that score.
- An assessment source is cryptographically authenticated, versus its educational claim is true.
- Evidence is portable, versus the receiving institution awards it credit.
- A mapping is useful for search, versus sufficient for credit/grade transfer.

For authentic performance-based work (coding, sports statistics, cooking, research, design), use anchored criteria, a demonstrable task, and a distinct independent check. Accepted evidence need not always be an on-screen quiz; teacher observation or an offline artifact may be more appropriate.

## 7. Crosswalk semantics and trust

### 7.1 Preserve author-owned meaning

The publisher's standard identifier, statement, source and version remain immutable in the adopted release. Local labels and overlays do not masquerade as a new publisher statement. The existing strict CASE codecs and named publisher adapters continue to run unchanged; compatibility repair must be explicit and provenance-recorded.

### 7.2 Different strengths of relationship

Use the registry's existing relation vocabulary. In particular:
- **Exact** needs publisher assertion or named human review, per existing schema.
- **Close/partial/broader/narrower** may be useful for recommendations, but do not imply the same learning requirement.
- **Prerequisite** is a sequencing relationship, not equivalence.
- **Related** is discovery only unless additional reviewed criteria justify more.

**No transitive equivalence inference.** If Texas A overlaps CCSS B, and CCSS B overlaps Michigan C, the system cannot silently infer that A fulfills C. More generally, do not compose relation edges into equivalence, credential awards, or local mastery without an explicit local review policy and evidence check.

AI similarity, embeddings and LLM reasoning may **propose** a mapping for review; they cannot turn it into an exact publisher assertion, alter official framework text, or bypass source-specific consent and local acceptance.

### 7.3 Independent mapping publishers

Any trusted or untrusted source can distribute a signed mapping pack, subject to local import approval and the project's content licensing rules. A signature proves authorship/integrity, *not* pedagogical correctness. Show whether a mapping was publisher-authored, reviewed by a person, or model-suggested. Districts can accept, reject or replace a mapping pack and retain prior approved versions for historical interpretation.

## 8. The personalized Learning Opportunity Planner

The planner is a local service/orchestration feature, **not** a replacement for approved curriculum, an unbounded chat prompt, or a general-purpose policy engine.

### 8.1 Two entry paths

- **Interest-first:** “I want to build a Roblox pizza restaurant.” Decompose the goal; retrieve locally relevant objectives and demonstrated knowledge; identify authentic concepts such as rates, state, and client/server authority; suggest the smallest useful instructional intervention.
- **Standards-first:** “This class must learn grade-six unit-rate reasoning.” Find personally relevant activities among student-selected projects; make required coverage transparent; offer meaningful choices where feasible.

Both paths use the same approved competency references, evidence contracts, teacher oversight, and assessment semantics.

### 8.2 Planning pipeline

1. Resolve trusted learner, offering, permissions, approved framework release and district AI-help floor.
2. Read **minimal permitted** learning state: confirmed competency evidence, teacher objectives and user-provided project intent; do not default to reading private conversations.
3. Generate candidate opportunities with a reason connecting *the learner's immediate goal* to *a specific standard*.
4. Validate referenced competency URI against the approved release; validate proposed criteria against a versioned evidence contract; reject invented or unsupported standards.
5. Rank eligible options by relevance, prerequisite readiness, accessibility, meaningful choice, curricular urgency and interruption cost. **Never optimize merely for retention or hours online.**
6. Present one useful step and explain why it is suggested. For optional topics, permit skip/defer. Do not disguise mandated curriculum as spontaneous discovery.
7. Help the learner perform a concrete task, using only the locally permitted AI assistance.
8. Capture separately authorized evidence and support a fresh independent check.
9. Update only justified claims and plan subsequent opportunities; leave teacher judgment and official grades distinct.

An appropriate outcome may be to close the application and do the activity in the physical world.

### 8.3 Learning invitations

A **LearningInvitation** is an optional, attributable topic suggestion, not a grade or requirement. It records the topic, rationale, issuer, permitted audience, status and expiration. Student-visible text should disclose a teacher or guardian recommendation instead of making it look like the AI's own spontaneous desire. Refusals should not be converted into punitive engagement scores.

**Guardian constraint:** ADR-0012 currently permits guardians to read only designated records; it denies every write and private conversation access. A guardian invitation feature therefore requires a separate explicitly approved policy/resource-kind/action change, a trusted active guardian relationship, a narrow one-way proposal endpoint, and abuse/rate controls. In v1, use teacher-authored invitations first. Do not ship guardian invitation writes by piggybacking on a general guardian read rule or on the student chat endpoint.

### 8.4 Coverage obligation

A student-interest path is not a guarantee that every required concept appears. The teacher dashboard must separately show:
- Framework **availability** (existing catalog coverage).
- Curriculum **scheduled/taught** exposure (activities pinned to goals).
- Evidence **practiced / independently demonstrated / retained / transferred** at each applicable standard.
- Required objectives with no justified pathway or insufficient evidence.

When no natural connection exists, recommend a transparent direct lesson, tutoring intervention or alternate activity. Do not manufacture a superficial connection merely to fill a dashboard cell.

## 9. Portability, issuer trust and local recognition

### 9.1 Extend P01/P02 rather than inventing a global passport

The current .educateos archive uses export-local learner IDs, content digests and bounded parsing. P02 already offers scope-limited consent, expiration, signed transfer statements and destination import. Those mechanisms remain authoritative for transporting records. A future evidence export must be added as a **new, versioned, rights-checked item class**, not silently folded into the existing schema or consent grant.

Do not include district-local principal IDs, private chat contents, school credentials, roster information or unrelated classmates' data in a portable claim. Preserve source revisions, allowed issuer identifiers, competence references and assistance conditions using appropriately pseudonymous archive references.

The existing consent model distinguishes learner- versus guardian-consent according to local policy, limits transfers to a chosen destination and item classes, and supports revocation. Reuse it; do not invent a universal age threshold or an additional default consent path.

### 9.2 Transfer handshake

1. Source authorizes a narrowly scoped export under current rights and consent.
2. Source produces a bounded, verifiable, versioned package.
3. Destination checks format, integrity, signature trust as configured, consent validity/revocation, and authorized learner identity linking.
4. Destination imports only permitted content into a quarantined local record; it never grants credit while importing.
5. The local review surface proposes possible applicable standards with conservative mapping semantics.
6. A locally authorized reviewer decides what, if anything, counts and whether further assessment is needed.
7. Any official grade/credit transition invokes the existing source-of-record authorization and approval path.
8. Subsequent withdrawal or correction is appended, not applied by silently rewriting historical signed evidence.

Offline verification should be possible with locally pinned trust material. No classroom transfer operation should require educateos.io to be reachable.

### 9.3 What CLR can and cannot do

1EdTech CLR 2.0 is a candidate interoperable representation for verifiable achievements and multiple issuers. Use the existing CLR seam as an adapter, not as proof of certified implementation. CLR records can support portable evidence, but a signed assertion still doesn't decide another institution's acceptance policy.

## 10. API and package boundaries (proposal)

Keep one trusted server-side authorization path, as required by ADR-0005 and RFC 0002. Do **not** implement separate privilege logic in UI, REST, MCP and scheduled jobs.

Candidate domain operations, names illustrative:

| Operation | Actor | Purpose | Default consequence |
| --- | --- | --- | --- |
| learning.list-eligible-opportunities | learner / authorized teacher | Read suggested next activities in a scoped context | Read-only, filtered |
| learning.propose-opportunity | trusted district planner | Prepare candidate mapping and explanation | Draft, not published |
| learning.accept-or-defer | learner | Choose an optional learning invitation | Only local preference change |
| learning.propose-invitation | authorized teacher | Suggest a topic for an identified offering or learner | Draft, review if required |
| evidence.record-observation | authorized assessment/teacher service | Anchor immutable work and criteria | No mastery automatically granted |
| evidence.propose-claim | evaluator/teacher | Draft supported/unsupported suggestion | No official grade |
| evidence.review-claim | authorized reviewer | Adopt or decline competency assertion | Recorded local decision |
| alignment.review-mapping | authorized curriculum reviewer | Permit relation for local search/planning/evidence screening | No credit/grading |
| transfer.review-imported-evidence | authorized receiving institution | Decide whether imported evidence fulfills a local standard | No automatic official grade |

Adding real operations requires changes to the closed authorization vocabulary and tests for each channel. No resource classification or authority may be supplied by untrusted model text. Exposing read-only operations to curated MCP clients can be considered after ABAC and data minimization; **evidence acceptance, grade approval, cross-district identity links, and guardian access changes must not be exposed as auto-approvable general MCP tools.**

Suggested package strategy:
- **@educateos/registry:** Extend only if new immutable crosswalk record primitives are genuinely shared; reuse existing CompetencyAssociation and EvidenceContract.
- **@educateos/catalog:** District-local mapping review and its historical versions; do not modify publisher releases in place.
- **@educateos/curriculum:** Approved opportunity/activity templates, bound to a course/term and the existing AI-help policy.
- **New orchestration module, tentatively @educateos/learning-planner:** Selection and explanation only, invoked through the district app; no separate authorization authority or central runtime.
- **@educateos/assessment:** Reviewed competence-claim/acceptance decision and source-of-record approval boundaries, separate from official-grade schema.
- **@educateos/portability:** Optional new evidence bundle class/adapter, only after a version and consent change are agreed.
- **@educateos/policy / contracts / district-app:** Reuse central action/resource vocabulary and trusted calls.
- **Student/teacher/admin UIs:** Opinionated views over the same API; no competing local policy implementations.

Storage remains inside the district's account or explicitly approved provider. Durable Object SQLite can store local policy decisions and append-only claim metadata; R2/learning artifacts continue to store digested evidence as permitted. No new cross-district data plane is proposed.

## 11. Product surfaces

### Student: “Build what you want; learn what you need”

The student can begin with a project, problem, or curiosity. The coach explains a concept *because it unlocks the next useful step* and tells the student how to apply it. A brief prediction, modification, observed failure, or transfer task can supply authentic evidence. The learner may defer optional invitations and inspect why a concept was suggested. Assistance level follows local policy.

### Teacher: coverage and evidence, not surveillance

Provide separate views for required objectives, available curriculum opportunities, demonstrated understanding, unsupported claims, and activities needing teacher action. Inspect a concrete artifact revision, rubric criterion and observed student action before approving. Show provenance and any AI assistance. Do not infer proficiency merely from project completion, time-on-task or chat eloquence.

### District administrator: standards and trust workbench

Review immutable standards releases and optional mapping packs, with source provenance, license/rights, changes from previous versions, and applicability scope. Distinguish **publisher-equivalent**, **human-reviewed exact**, **partial/related**, and **unreviewed model-suggested** relations. Explain which local processes may use an association and what it *cannot* authorize.

### Family: invitations and respectful summaries

Where an authorized guardian relationship and future explicit policy allow it, show narrow progress summaries and let an adult suggest a topic. Do not expose personal-private work or unrestricted conversations; ADR-0012's read restrictions continue to apply until deliberately amended. Students can see whose suggestion they received.

## 12. Threats and failure modes

| Threat | Required defense |
| --- | --- |
| AI invents a standards identifier or an exact mapping | Resolve pinned approved registry URI; reject unknown references; require human/publisher evidence for exact |
| Transitive partial associations become claimed credit | No inferred equivalence across unreviewed chains; explicit receiving decision |
| AI fixes code and receives student mastery credit | Record assistance/provenance; require independent student action for claims requiring independence |
| Imported file is authentic but academically misleading | Validate source integrity separately from rubric sufficiency and local acceptance |
| Transfer reaches the wrong learner/district | Preserve P02 destination binding, consent, trusted identity link and per-district principal isolation |
| Guardian prompts become covert directions or private-data access | No writes until narrow authorization is implemented; clear origin labels, visibility and opt-out |
| Marketplace publisher tries to set policy or run scripts | Signed **data-only** OCS and explicitly approved resources; no extension of local authority |
| Model output includes malicious instructions | Treat imported source, student text and third-party material as data; agent tools authorize every action |
| District root outage or marketplace compromise | Local pinned releases, local records and independent runtime; tests with root unavailable |
| “Better engagement” becomes automated psychological profiling | No session-time optimization, emotion inference or automated SEL profiling; minimize personalization inputs |
| Need for authentic cross-school research causes PII aggregation | Publish opt-in aggregate evaluation artifacts separately; never a default learner telemetry stream |
| Rubric or standards revised mid-term | Version pin source and assessment; retain old decisions, show diffs, append superseding decisions |

## 13. Demonstration scenario: two independent districts

Use only repository synthetic fixtures, never real student data.

**Northfield** (district OIDC / Canvas grade authority) installs a unit-rate activity with a conventional table-and-graph approach. **Cedar Valley** (Clever / Google Classroom grade authority) selects a student-project variant such as a restaurant game. The two institutions may use different frameworks, rubrics, and workflows, and should use explicit locally approved releases; do not assume TEKS is automatically installed or that the classes share grade authority.

Expected behavior:

1. Both institutions can produce evidence anchored to their *own* released objective and rubric, with independently verified learner contributions.
2. The catalog correctly describes each district's available framework separately from actual student mastery.
3. A community-published proposed mapping enters the review queue and is not active merely because it was downloaded.
4. A model-suggested “exact” relation without human/publisher review is refused by the existing registry contract.
5. A declined mapping does not affect the other district.
6. A learner exports only authorized items under P02, with source and target bound, signed transfer, and pseudonymous archive IDs.
7. Cedar Valley rejects a Northfield-district principal or untrusted signed package without automatically linking the learner.
8. Once identity and consent checks pass, the receiving reviewer may mark an imported record **partially relevant** and request a targeted assessment, without issuing an official grade.
9. Only the receiving institution's separately approved official-grade operation may write to its grade source of record.
10. Neither district relies on the EducateOS website to operate; a root outage changes nothing about local review.

Other synthetic districts in the existing six-district harness should cover alternate roster/LMS combinations, a shared family email, inactive enrollments, a guardian with a pending relationship, and identity subjects that look similar across districts.

## 14. Acceptance tests and rollout gates

### Gate FLE-0 — docs, contracts and policy (no runtime behavior)

- Accepted RFC, boundary/ownership decisions and authorization matrix.
- Strict schemas for conceptually separate proposal, observation, claim, review and acceptance records.
- Tests prove that unknown standards, stale framework digests, duplicate decisions and missing required evidence are rejected.
- Existing CASE, OCS and archive formats remain backwards compatible.

### Gate FLE-1 — one district, no cross-district records

- Teacher approves a local framework; student creates an interest-led project.
- Planner proposes a relevant standard with a traceable reason and a task the student can perform.
- Student can refuse/defer an optional activity; required work is visibly required.
- Assessment suggestion cannot become a competency claim or an official grade without required approval.
- Teacher sees **framework available**, **activity encountered**, **student practiced**, and **student demonstrated** as different indicators.
- No model-supplied role, action metadata, student ID or prompt can alter authority.

### Gate FLE-2 — two-district federation

- District A can approve a mapping that district B declines; both retain independent configuration.
- Partial and AI-only mappings cannot cause an exact-match or credit conclusion.
- Signed, scoped, consented learner transfer can be validated and reviewed locally; revoked, expired, tampered, oversized or wrong-destination attempts fail closed.
- Imported evidence is quarantined until reviewed and never changes grades on import.
- No source PII, district-local identifiers or private work traverse unless specifically permitted by existing transfer rights.
- Simulated loss of educateos.io never interrupts local classroom operations.

### Gate FLE-3 — educational validation before broad claims

- Curriculum specialists review mappings and evidence contracts for a focused set of grade-level outcomes.
- Evaluate at least two instructional paths to one standard using *common independent assessment criteria*.
- Report student engagement and educator workload separately from demonstrated learning, delayed retention and transfer.
- Measure false-positive mastery claims, mapping disagreements and opportunities proposed without genuine relevance.
- Do not publish causal efficacy claims from observational usage data alone.

## 15. Implementation slices (proposed)

**Slice A — Local evidence/acceptance contract.** Extend an existing package with reviewable competence evidence and receipt binding; integrate into teacher UI without touching cross-district wire formats. Include negative authorization tests.

**Slice B — Crosswalk review.** Add a district-local MappingAcceptance store/view over existing CompetencyAssociation releases. Preserve provenance and reject unreviewed exact claims. Ship a diff/review screen rather than editing imported CASE data.

**Slice C — Learning Opportunity Planner.** In a single subject/grade band, combine a student project, a teacher-targeted standard and an EvidenceContract. Respect current AI-help floors, student choice and clear mandatory/optional labels.

**Slice D — Coverage layers.** Distinguish framework availability, scheduled exposure, assessed evidence and locally accepted proficiency. Don't overload the existing catalog coverageReport function.

**Slice E — Optional transfer evidence version.** Design the new export record, granular consent item class and destination acceptance workflow. Add it to the existing P01/P02 paths only after rights, guardian consent and trust review.

**Slice F — Invitation and collaboration governance.** Start teacher-authored; introduce guardian invitations only after an ADR and closed authorization vocabulary change. Enable sharing of reviewed public learning packages without any automatic sharing of students' records.

Recommend working in small PRs, keeping kernel/shared-contract edits isolated and auditable. Changes that modify the student archive format or trusted credential model warrant dedicated ADRs, version bumps and migration tests.

## 16. Rejected alternatives

1. **One national canonical competency graph:** simplifies matching on paper but silently centralizes meaning and loses local revisions/disagreements. Use source-owned frameworks and explicit associations.
2. **Treat every mapping as exact after embedding similarity:** confuses topical similarity with academic equivalence and can issue false credit. Use conservative suggestions and human/publisher review.
3. **Attach a single mastery score to every student:** destroys provenance, assistance conditions and institutional context. Keep claims per competency, conditions, rubric and source.
4. **Transfer the original district's official grade as the destination's grade:** bypasses receiving assessment authority and source-of-record checks. Transfer evidence; make new local decisions.
5. **Make every school fetch live runtime policy from educateos.io:** violates root independence and district ownership. Ship approved signed data; enforce district-local policy.
6. **Make parent suggestions invisible steering instructions:** risks manipulative personalization and gives unreviewed guardian writes. Make attribution and opt-out explicit and scope permission.
7. **Turn every educator choice into a monotonic policy floor:** mistakes pedagogy for privacy/security enforcement. Keep academic choices delegated, protective floors monotonic.
8. **Rewrite CASE, OCS, CLR or current assessment services:** duplicates code and weakens conformance boundaries. Extend through adapters and domain-specific records.

## 17. Open questions requiring decisions

- What local actor can approve evidence-to-competency claims at each school level? Is teacher review always necessary, or may a district authorize a separately reviewed deterministic check for some low-stakes competencies?
- What format and trust policy should represent externally issued claims while avoiding a new universal learner identity? Where is a verified issuer key pinned and rotated?
- Which assistance conditions can an institution responsibly infer versus only trust from a student declaration or a controlled test?
- What is the right minimal data retention window for interest signals and optional invitations, especially with students under 13?
- Can portable evidence retain original school-specific rubrics without redistributing material the school or publisher has not licensed?
- How should accessibility accommodations be recorded for assessing comparability without exposing sensitive disability records?
- How do districts appeal, supersede or withdraw local acceptance decisions after a standard or mapping changes?
- Which outcomes should first be supported by publicly reviewed crosswalks: grade-six unit rates, evidence-based writing, or foundational reading?
- How will the system report conflicting institutional determinations without implying that one institution is necessarily wrong?
- How do shared curriculum evaluation studies avoid confounding from student self-selection and unequal access to opportunities?

## 18. Documentation, interoperability and compliance references

**Internal primary records**

- [EducateOS architecture and maturity](../README.md)
- [Current maturity ledger](../maturity.md)
- [District data ownership, ADR-0001](../adr/0001-district-data-ownership.md)
- [Policy floors, ADR-0004](../adr/0004-capability-packs-and-policy-floors.md)
- [Default-deny policy, ADR-0005](../adr/0005-authorization-vocabulary.md)
- [Open-source charter, ADR-0011](../adr/0011-open-source-charter-and-module-ownership.md)
- [Guardians and dated roles, ADR-0012](../adr/0012-guardians-and-dated-roles.md)
- [OCS course specification, RFC 0001](0001-open-course-specification.md)
- [Integration Fabric, RFC 0002](0002-integration-fabric.md)
- [Student archive format](../educateos-archive-format.md)
- [Standards licensing](../standards-licensing.md)

**External standards/guidance**

- [1EdTech CASE 1.1](https://www.1edtech.org/standards/case) — exchange of academic standards, GUIDs, associations and optional rubrics.
- [1EdTech CLR 2.0](https://www.1edtech.org/standards/clr) — learner-controlled, verifiable achievement records; interoperability does not guarantee local credit.
- [FERPA school official exception](https://studentprivacy.ed.gov/faq/who-school-official-under-ferpa) — conditions on outside providers handling education records. Actual district disclosure/transfer and consent decisions require local legal review.

### Status note

This document intentionally describes both existing constraints and **proposed** extension points. It does not create routes, authorize guardian writes, issue credential trust, claim external conformance, or change an installed district. Each implementation slice requires its own code, tests, review and maturity update.
