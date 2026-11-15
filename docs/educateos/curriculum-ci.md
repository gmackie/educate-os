# Curriculum CI v0: course-wide read-only preflight

**Status:** Draft implementation, November 15, 2026. This is neither a new OCS specification nor evidence of educational efficacy, accessibility certification or authorization to redistribute content.

**Code:** packages/educateos-district-app/src/curriculum-preflight.ts, courses API route teacher.previewCurriculumPreflight, Teacher Studio CoursePanel, and synthetic district tests.

## Why this exists

Content Studio reviews each imported resource for license/attribution, basic accessibility, unsafe active content and other ingestion concerns. OCS 1.1 independently verifies the structural integrity of a course and its portable activity dependencies. Assessment CI evaluates submitted student work under its own privacy and grade controls.

A teacher needs a **single, honest course-level readiness report** before deciding to adopt, adapt or share a curriculum. This read-only preflight assembles existing verified OCS metadata and district-approved CASE references. It never implies that technical validation establishes instructional quality.

**No centralized AI service, Foundation account, student data or network request is required.**

## API and response contract

POST /api/teacher/offerings/:offeringId/course-library/preflight

Body is the existing CourseInstallInput: { packageId, version }.
The route uses the same class-scoped teacher authorization as course preview/import.

Response is CurriculumPreflightBody:
- exact package ID, version, indexed digest and published title;
- publicationApproved: false, readOnly: true;
- deterministic check statuses and concise text explanations;
- counts of pass, attention and not-verified across ten defined dimensions.

The application first resolves the course using planLibraryInstall, which verifies structure and stored digests; portable activity exports also resolve by exact digest. The report relies only on local package metadata plus the district's approved-standard catalog. It does not contact a central registry, run a model, or invoke any mutation API.

## Checks and their evidentiary limits

| Check | What v0 establishes | What it does NOT establish |
| --- | --- | --- |
| Package integrity | Accepted package structure, resolved dependencies and pinned exports in stored district library | Independent human quality, current license validity, fresh publisher identity verification |
| Publisher trust | Whether import indexed a signed publisher | Human author attribution, copyright ownership, current key trust or institutional endorsement |
| Standards | Referenced CASE alignments accepted by district catalog | Correct depth of instruction, cross-state equivalence, measured standard mastery |
| Activity portability | Whether activities use portable definitions rather than district-local IDs | Classroom readiness, quality of rubric, assessment security |
| Resource portability | Whether district-local OCS resource references remain | Rights-cleared PPTX/PDF export, actual media safety or accessibility |
| Reading attribution | Whether activity readings declare attribution metadata | Accurate authorship claims, lawful license for redistribution |
| Instructor material | Whether bundles declare teacher-only notes / answer keys | Confidentiality of plaintext in publicly downloadable OCS bundles |
| Copyright rights | Not verified | Permission to publish/copy outside original school |
| Accessibility | Not verified | WCAG compliance or adequacy for disabled students |
| Educational effectiveness | Not verified | Better student outcomes or causal impact |

Always display "not verified" when a dimension requires separate human, legal or technical investigation. Even a fully green metadata report cannot grant publication permission or override local school policy.

## Design constraints and user experience

The report is visible only to a locally authorized teacher. It contains no student identifiers, student submissions, prompts, grades, teacher-only note contents or quoted lesson bodies. All untrusted text is displayed through the existing React UI as text, not rendered as executable HTML.

Teachers can open "Quality checks" from the district course library and return without making any changes. The action does not publish a course, import a resource, approve an assignment, create a grade, or initiate external collaboration.

If a course references a district-local resource, the report flags it for manual portability/rights review. The actual upload or download path remains controlled by Content Studio and the school.

## What to build next, in order

1. **Course-level run identity.** Save a separate immutable report referencing exact OCS package/version/digest, check definition versions and district policy revision. Do not store results in the published course manifest. Teachers should be able to compare a new preflight to one run on an earlier version.
2. **Pedagogical Intent Profile (detached).** Define optional, versioned, reviewable claims for learning objective, prerequisites, misconceptions, teaching constraints and expected demonstration of understanding. Align by source-owned CASE competency URIs. Explicitly distinguish author claims from independently reviewed claims.
3. **AI co-maintainer (teacher-draft only).** The teacher selects a source and a goal. The model receives bounded, authorized instructional context without student records. It proposes a separately stored local draft and a structured explanation of changes; no automatic publication or external proposal submission. Use district AI Gateway policy, spend caps and untrusted-content isolation.
4. **Pluggable evaluators.** Reuse Content Studio checks for actual media, and add optional subject-specific correctness checks (e.g., arithmetic solutions and cited source verification) with explicit evaluator version and false-positive tests. Run evaluation on the draft; never mark AI output as approved by the model that generated it.
5. **Evidence Passport.** A signed or otherwise authenticated, detached record that distinguishes machine checks, subject review, accessibility review, use observations and study evidence. Include exact course artifact digest, assertion issuer, review methodology, date and scope. A credential format such as W3C VC 2.0 may be evaluated later; do not add cryptographic complexity prematurely.
6. **Contribution to Commons.** After local content/rights review, an authorized teacher explicitly offers a candidate revision to a publisher's inbox using the detached contribution profile in open-course-standard PR #7. A publisher's acceptance can lead to a *new* signed release. Recipient institutions independently decide whether to update classes.
7. **Outcome research.** Later studies can connect Passport metadata to properly governed evaluation evidence. Keep student-level events in the originating institution; externally share only specifically authorized, privacy-reviewed, statistically defensible findings.

## Acceptance gates for the current v0

- Teacher can inspect a signed imported OCS course without installing it.
- Source tampering or wrong publisher key is rejected by existing import/resolver paths.
- A missing/unapproved CASE reference is flagged, not automatically relabeled equivalent.
- Teacher-only Codex notes flag a public-distribution risk, rather than a confidentiality guarantee.
- Unknown copyright, accessibility and educational efficacy are never shown as "passed".
- A student/other unauthorized principal cannot call the route.
- Course outline, course-install records, assignments, student work and grades are unchanged before/after preview.
- CI builds TypeScript and UI, runs synthetic district tests and existing OCS unit checks.

## Non-goals

This is not an editor, AI agent, plagiarism scanner, copyright determination engine, legal review, catalog, LMS importer, classroom update executor or experimental proof of learning gains. Content Studio and OCS keep their established authority boundaries.

## Related work

- Independent OCS collaboration profiles: https://github.com/gmackie/open-course-standard/pull/7
- EducateOS cross-school Course Commons RFC: https://github.com/gmackie/educate-os/pull/32
- Provenance mapping PR: https://github.com/gmackie/educate-os/pull/33
- Teacher course-update inspector PR: https://github.com/gmackie/educate-os/pull/34
- Technical roadmap: docs/educateos/course-commons-technical-delivery-plan.md (draft PR #32, not yet on main)

### External specifications

- CASE 1.1: https://standards.1edtech.org/case/
- Common Cartridge: https://www.1edtech.org/standards/cc
- W3C Verifiable Credentials 2.0: https://www.w3.org/TR/vc-data-model/
