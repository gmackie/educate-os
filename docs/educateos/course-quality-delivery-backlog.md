# Course Commons quality flywheel — implementation work packages

**Status:** Proposed executable backlog, November 15, 2026. Replaces issue tickets until a tracker is available. None of the following is shipped by the associated contracts PR.

## Delivery contract

Deliver in this dependency order. Each slice must be independently testable and must not change normative OCS 1.1 syntax, publisher signing bytes or student record retention.

- Curriculum CI preflight: PR #35. A read-only quality metadata report, not a certification.
- Pedagogical Intent and Evidence Passport validation: PR #36. Data contracts only.
- Course source-to-local IDs: PR #33, course update inspector: PR #34, stacked.
- Cross-institution collaboration RFC: PR #32, OCS detached proposal experiments: open-course-standard PR #7.

### CQ-01: Immutable district-owned Curriculum CI runs

**Scope:** Use a separate district-owned durable store keyed by run ID and exact OCS package ID/version/digest; record check implementation versions, CASE catalog approval/policy revision, request principal/time, report digest and status. Expose authorized create/list/read endpoints; never put reports inside OCS packages.

**Acceptance:** After a run, teacher can compare it with an earlier immutable run; restarting the Durable Object cannot rewrite a run; idempotent replays do not create competing history. A stale source, changed catalog policy, changed reviewer privileges and mixed publisher keys are visibly refused or marked stale. No student data, prompts, teacher-only source bodies or grades in result records. Existing read-only preflight continues to work.

**Quality gate:** Tests for authorized teacher/administrator vs student/guardian/cross-offering access; CAS concurrency, retry, DB restore and no classroom mutation. A deterministic check is *not* a claim that author rights or student learning have been verified.

### CQ-02: Private teacher AI course co-maintainer

**Scope:** The teacher explicitly selects an approved OCS course unit and states an adaptation goal. Use the district's currently supported AI Gateway/model governor and budget; no new central inference service. Build a bounded input from permissible non-student instructional text and approved CASE metadata. Treat all course text as untrusted data. Validate generated output as PedagogicalIntentV0 with origin machine-suggestion and the exact source digest, plus a reviewable proposal for specific changes. Keep the proposal private and draft-only.

**Acceptance:** Teacher can see what changed and why, accept a subset or discard it without changing active classroom content or external publisher packages. Never publish, email, create an upstream proposal, enroll students or record a grade based on a model's unreviewed output.

**Quality gate:** Unsupported model, AI budget exceeded, role revoked, provider outage, prompt injection, fabricated standards, invalid content/markup, stale course digest, malicious document and denial-of-service tests must fail safely. Capture bounded cost/tokens in the existing district ledger without copying sensitive lesson/student text to the usage logs. Human review precedes every local adoption.

**Dependency:** CQ-01 for preflight source context, PedagogicalIntent contract in PR #36, local edition/staging work from PR #32 before "accept changes" mutates course draft state. For the first proof of value, it is acceptable to generate a proposal and let a teacher discard it; do not fake an available apply route.

### CQ-03: Evidence Passport review and attestations

**Scope:** Assemble evidence claims for one exact signed OCS version from course preflight runs, educator reviews and methodologically documented research. Keep a complete issuer/method/scope trail. Distinguish automatic technical verification, qualified teacher/subject review, accessibility review, copyright assessment and outcomes research. Do not create a global numerical ranking or a "verified effectiveness" badge.

**Acceptance:** Publisher/recipient can independently validate source digest, issuer authority and the appropriate reviewer decision. A third-party claim does not become trusted by having schema-valid JSON. A new OCS version does not silently inherit an old passport's approvals. Studies are linked with sample, design, limitations and provenance; no student-level events in public records.

**Quality gate:** Tests prevent forged signatures, stale claims, false model/self-report "pass", hidden answer keys, private classroom information and small-cohort reidentification risk. Human/third-party verification is a separate permissioned action. Public release is explicitly requested and legally/privately reviewed.

**Dependency:** CQ-01 and passport contract in PR #36. Detached publisher profile governance must be reviewed independently.

### CQ-04: Closed-loop course contribution demonstration

**Scope:** Two independently governed institutional accounts use OCS to exchange one rights-cleared science lesson. One educator proposes an improvement to the original publisher; an authorized maintainer accepts or rejects it and, if accepted, signs a new immutable version. The recipient can review and optionally adopt it without damaging the local edition. A non-EducateOS consumer should be included before claiming vendor-neutral end-to-end interoperability.

**Acceptance:** Verified publisher keys, exact source-to-local IDs, review decision audit, no global login, no student data, explicit teacher approval, rejection and rollback demonstrated; Foundation discovery outage does not break imported classes.

**Dependency:** PR #33/#34, reviewed local edition/activation design, OCS PR #7 and Course Commons RFC. Test with synthetic records before educator pilots.

## Product measurement

For pilot educators, compare against their current LMS, Drive or email method: time to find material, time to adapt, acceptance and rejection rates, review minutes, false-positive flags, accessibility exceptions, rights clearance costs and percent completing the workflow without developer help. Track the cost of any inference and human review separately. Avoid equating downloads with actual learning improvement.

## Stop conditions

No student data in public metadata or cross-institution proposals. No auto-update of historical rubrics/grades. No AI self-approval. No transfer of third-party licensed files without rights review. No mandatory Foundation service for an independently hosted district. No claim of interoperability certification or causal educational effectiveness from technical tests alone.
