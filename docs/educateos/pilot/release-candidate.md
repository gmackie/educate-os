# WIP: EducateOS Pilot Release Candidate (SCHO-434)

Review candidate only. No real student records, paid model run, merge or deployment was used to
prepare this candidate. There is no deployed candidate demo URL. The synthetic replay exercises
real district API handlers in memory; Worker tests exercise SQLite/workerd with fake bindings.

## Integrated sources

| Layer | Source | Integration |
| --- | --- | --- |
| Foundation, PLP UIs, home learning, admin CI repair | [PR #406](https://git.forgegraf.com/gmackie/educate-os/pulls/406), `af97dbe01d13fa34695c1126ab5b45ece0851184` | Exact base; preserved |
| Synthetic pilot, standards audit and reviewed golden | [PR #410](https://git.forgegraf.com/gmackie/educate-os/pulls/410), `d4140b01097d9232b1f0922813f01d00fc99718b` | Cherry-picked, no conflicts |
| Governed AI runtime, SCHO-431 | [PR #412](https://git.forgegraf.com/gmackie/educate-os/pulls/412), `86a13793ee026b3d05204af59998edb7a8b962ec` | Cherry-picked, no conflicts |
| Student lifecycle, SCHO-433 | [PR #413](https://git.forgegraf.com/gmackie/educate-os/pulls/413), `17aa1655cabd17868307a717478db884a80ce355` | Cherry-picked; sole export-list conflict resolved by preserving both exports |
| LevelForge local companion | Separate sibling repository | No sibling source imported; committed contract/PR evidence pending |

Only committed producer objects are integrated. The candidate targets `feat/plp-integrated-learning`,
not main. A passing synthetic script establishes software behavior, never actual student learning.

## Synthetic setup and acceptance

Use the repository's pinned pnpm with Node 24 or newer. Install with `pnpm install --frozen-lockfile`.
All personas in Pilot Lakes are invented. Do not substitute production exports or student responses.

```sh
pnpm educateos:pilot --check
cd packages/educateos-harness
pnpm exec vitest run --config vitest.config.ts __tests__/pilot-journeys.test.ts __tests__/pilot-adversarial.test.ts __tests__/pilot-release.test.ts
```

Run other suites from each package's own directory, using `pnpm exec vitest run --config vitest.config.ts`:

| Package | Test files | Acceptance |
| --- | --- | --- |
| `educateos-harness` | `pilot-journeys`, `pilot-adversarial`, `pilot-release` | Golden replay, approved registry alignments, wrong subject/district, opted-in guardian suggestions, shared teacher evidence, no AI/game mastery, legal hold and selected-student purge, retained AI grant cannot bypass write fence |
| `educateos-district-app` | `planner`, `planner-adaptive`, `planner-ai`, `planner-integration`, `guidance` | Student ownership, role scope, independent teacher checks, delayed evidence, model/budget denials and aligned screened output |
| `educateos-district-worker` | `planner-runtime` | Default off, missing/revoked/expired grants, approved model/funding, screening, usage settlement, consent rechecks, quotas and persistent breaker through actual Worker composition |
| `educateos-student-ui` | `planner` | Optional AI request resets, useful curriculum fallback, explicit sharing and assistance disclosure |

Worker tests need local socket permission for workerd; they use fake AI/guard bindings and never
call a paid model. Run changed-package `pnpm exec tsc -p <package-path> --noEmit` from the repository
root. `pnpm lint` checks scripts, generated configs, curriculum and workspace builds. Preserve the
known unrelated environment snapshot test failure if encountered; do not rewrite its baseline.
The PR records exact results and CI state for its published head.

## Consent and operator review before any future pilot

Read the [teacher/family guide](learning-pilot-guide.md), [evaluation plan](learning-pilot-evaluation.md)
and [runtime configuration](../planner-ai-runtime.md). The disabled AI example is intentional.
Curriculum works without AI. K–5 planning/model access remains denied. An AI explanation needs
district enablement, approved offering/model/funding, active district-confirmed guardian authorization,
curriculum permission and the learner's explicit per-request choice. Guardian suggestion/progress
permissions are separate, off by default, and revocable; they do not authorize model processing.

Teacher-visible evidence requires explicit sharing. AI-assisted or game completion is practice,
and cannot supply automatic mastery or an official grade. Teachers need a separate unseen independent
assessment; retention needs a later check and transfer needs a different context. Keyword matching
can suggest a poor fit, so standards/task review and the student's right to skip remain essential.

The [student learning deletion runbook](../runbooks/student-learning-deletion.md) defines the
integrated purge scope: optional planner/guidance records are erased, active guardian guidance
grants are revoked, and a terminal write fence prevents stale or fresh planner writes. Disposition,
archive and retention review are required; legal hold blocks purge. Identity relationships and
content-free deletion receipts/audit remain. Combined tests verify classmates' records survive.

**AI consent grants, runtime usage counters and AI ledger records are not purged by this API.**
The grant lives in deployment configuration and must be separately revoked by an operator. The
combined test deliberately retains a grant and verifies the deleted student's planner cannot call
the model again. This does not prove cancellation of a request already in flight; revoke AI consent
and quiesce pending requests before erasure. Source artifacts, provider logs, central/workspace hold
synchronization, complete planner archives and browser push invalidation are also outside this scope.
This candidate remains synthetic-only and does not claim complete student data deletion.

The LevelForge adapter contract must bind district, offering, student, project/source revision,
approved competency and assistance, reject replay/mismatched subjects, and preserve teacher review.
Existing `planner-integration` tests cover the EducateOS inbox side. They do not certify an unavailable
companion build, desktop pairing or a live LevelForge connection.

No measured student outcomes exist. The pre/post/delayed evaluation remains a proposed district
study requiring consent and independent assessment. Legal/DPA review and actual installation,
accessibility, operational readiness and district approval remain separate pilot gates.

## Stacked assessment follow-up (SCHO-435)

See [criterion-level teacher reconfirmation](criterion-review.md) for the narrow assessment change
stacked on PR #417. It preserves old judgments as historical, requires new criterion observations for
reconfirmation, and gives teachers source/rating/reviewer history plus withdrawal. Synthetic tests
establish software behavior only; educator agreement and live-school validity remain unvalidated.
