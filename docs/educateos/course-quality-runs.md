# Curriculum CI: immutable historical quality runs

Status: Draft feature stacked on Curriculum CI preflight PR #35. Not merged/deployed, not an OCS 1.1 extension or educational certification.

A one-time, read-only course preview cannot serve as a durable baseline for reviewing future AI suggestions. This feature records an explicit teacher-requested, district-owned historical Curriculum CI report pinned to the original OCS package ID/version/digest.

## Data and storage

A CourseQualityRun contains:
- opaque run ID, offering scope, requester, idempotency key and timestamp;
- the bounded technical and metadata checks from the existing curriculum preflight;
- a curriculum-preflight-v0.1 implementation version and SHA-256 fingerprint of the report;
- SHA-256 fingerprint of the exact standards-reference decisions made during evaluation;
- SHA-256 fingerprint of district settings and optional latest config revision;
- immutable historicalOnly: true. A historical report never approves redistribution, course updates or assignments.

The store lives in the local district application. In memory it returns deep copies. In production, a SQLite-backed Durable Object has an append-only table, per-offering index, unique (offering, requester, request key) idempotency constraint and UPDATE/DELETE refusal triggers. No Foundation service is involved.

These fingerprints cover only the inputs the preflight read, not every possible remote policy change. Any actual publication or adoption action must reevaluate identity, digest, standards, rights and current district policy. A previous technical report cannot authorize a future action.

## API and authorization

POST /api/teacher/offerings/:offeringId/course-library/quality-runs
GET /api/teacher/offerings/:offeringId/course-library/quality-runs
GET /api/teacher/offerings/:offeringId/course-library/quality-runs/:runId

All routes use the existing class-scoped activity authoring permission. Authorization precedes lookup of course or report existence. A repeated request key and identical source/report/context returns the first run. A reused key with changed input/context yields a conflict. Different teachers/offerings have distinct namespaces.

Teacher Studio exposes Save report, Review saved reports, and historical-only notices. There is no apply, publish or automatic inference action.

## Security and scope

No raw lesson content, instructor note bodies, student records, submissions, grades, credentials or model prompts enter the report. It stores ten bounded metadata check summaries, a verified source fingerprint and local teacher/request context.

No human review, issuer attestation, accessibility certification, legal license grant or learning-impact verdict is implied. Those dimensions remain explicitly not verified.

## Test gates

- A new run is immutable and accurately pinned to its source/evaluation context.
- Request replay with the same key returns the identical record; changed context conflicts.
- Students, guests, revoked principals and cross-offering users cannot read or create runs.
- Quality run creation leaves lesson content and course installation records unchanged.
- SQLite schema survives Durable Object restart; uniqueness and triggers prevent accidental rewrite.
- No student data or restricted answer keys appear in historical reports.
- CI validates TypeScript, UI and worker-compatible storage.

Current route tests cover in-memory authorization and idempotency; durable restart, corrupt-row and legacy migration test evidence remains a separate pre-production gate.

## Follow-on: teacher-governed AI proposals

The AI co-maintainer should explicitly use the district's existing model governor, allowed provider/model, spending budget and per-request audit. It may propose a private, bounded Pedagogical Intent draft linked to exact OCS version/digest and recent local technical report. It may not publish, change LMS assignments, access student records, or certify its own suggestions.

Related contracts: PR #36; Course Commons workflow PR #32; course provenance PR #33; read-only update inspector PR #34.
