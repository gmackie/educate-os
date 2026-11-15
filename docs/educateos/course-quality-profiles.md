# Course-quality metadata profiles — pedagogical intent and Evidence Passport (experimental)

Status: Draft validation contracts, 2026-11-15. Neither profile is part of the Open Course Standard (OCS) 1.1 normative format. There is no Teacher Studio editor, model inference, issuer attestation, review inbox, persistent storage, import/export endpoint or certification in this PR.

Source and tests: packages/educateos-curriculum/src/course-quality-profiles.ts and packages/educateos-curriculum/__tests__/quality-profiles.test.ts.

## Why separate profiles?

OCS already solves immutable package structure, content digests, module composition and publisher signatures. The Commons needs additional metadata that is useful for teachers, but should not force one pedagogical approach or a central standards authority. Publishing claims about learning outcomes needs an especially high evidentiary bar.

A profile binds to an exact, independently checked OCS publication ID/version/digest, and is kept outside the strict OCS package. Optional unit keys identify a particular part of the source; a new package release must not silently inherit old quality claims. A compatible non-EducateOS implementation may ignore both profiles without losing the ability to read valid OCS 1.1 courses.

## Pedagogical Intent v0

A draft for an educator or model to suggest:
- Intended learning objectives and author-declared CASE links
- Prerequisite concepts and frequent misconceptions
- Teaching strategies with their use conditions and rationale
- Observable ways students might demonstrate understanding
- Classroom constraints such as time, equipment and accessibility needs

There is no required K-12 grade band, credit system or institution, so the profile can be used from primary school through higher education.

Origin distinguishes educator-draft and machine-suggestion. Both are proposals; neither asserts that a curriculum administrator or subject-matter reviewer approved them.

Every expected demonstration must reference a declared learning goal, and identifiers must be unique within their section. Bounded plain text, strict JSON-like shapes and active-markup checks are part of the validator. These checks do not detect every instance of personal data or malicious prompt text. Content must still be handled as untrusted data and reviewed before any sharing.

This profile is not a student-assessment record. It contains no rubric result, learner identity, grade or real student response.

## Evidence Passport v0

A bounded index of claims tied to one exact OCS publication, rather than a single numeric "lesson quality score." A claim has a dimension, finding, basis, method/version, issuer assertion, reporting time and short explanation.

Dimensions include package integrity, standards references, resource attribution, copyright rights, accessibility, subject accuracy, instructional design, classroom use and learning outcomes.

Conservative constraints:

- Claims sourced only from an AI model or self-report cannot declare a pass.
- Deterministic checks may pass only narrow technical dimensions, not legal rights, accessibility, subject accuracy or pedagogical effectiveness.
- There is no generic pass for learning outcomes. A properly described research publication can be indexed as study-reported, which itself is not a causal or population-wide effectiveness verdict.
- Passport fields independentlyVerified and publicationApproved are always false in version 0. The schema does not validate the issuer's identity, qualifications, license or external research.
- A recipient must verify both the subject's source digest and the claimant's authority before presenting any assertion as trusted.

Never attach raw student submissions, rosters, grades, teacher-only answer keys, small-cell outcome data, credential material or private communications to a public passport.

## What the existing Curriculum CI branch adds

PR #35 offers read-only course-wide technical checks over the district's existing OCS course library. The immediate integration after these profiles are reviewed is an immutable district-owned report record that binds individual preflight findings to the exact course digest, check implementation version and local policy revision. Do not treat automatic record creation as an educator's independent subject review.

## Suggested teacher workflow (not yet implemented)

1. An authorized teacher opens an imported course and runs Curriculum CI.
2. The teacher asks a locally governed AI assistant to suggest a Pedagogical Intent draft using bounded course context, district-approved goals, a model budget and no learner records.
3. The teacher reviews the proposed goals, strategies and adaptations; the model cannot publish or accept changes on its own.
4. Independently authorized reviewers check applicable legal rights, subject accuracy and accessibility.
5. A separate local Evidence Passport references their signed or authenticated review decisions, exact source publication and the evaluations they performed.
6. Only after institutional approval may a publisher release appropriate metadata, without sending student-level information to the Foundation.
7. After a new edition is published, its claims are scoped to the new digest; prior reviews may be linked historically but never transferred as verified without review.

The tracked follow-on work packages, with acceptance tests and dependencies, are in [Course Commons quality delivery backlog](course-quality-delivery-backlog.md).

## Engineering next steps

- Build immutable district-owned run storage with source digest and policy/check versions; ensure stale runs do not authorize new publications.
- Integrate teacher-draft AI suggestions through existing AI Gateway budget and policy, with bounded structured output and review UX.
- Define verifiable reviewer/issuer attestations and copyright clearance before cross-institution publication.
- Add actual supported evidence links, review methodology, external publisher portability and accessibility review.
- Create test cases covering forgery, stale source refs, false "pass" claims, malicious content, district privacy and no default model inference.

See Curriculum CI PR #35, Course Commons architecture PR #32 and the independent OCS collaboration profiles PR #7. No normative OCS 1.1 schema or digest bytes are modified here.
