# Checkpoint/release integration validation — SCHO-288

Base: PR #18, `17472c2f64b22e40894a2f086eef2d057402c96f`.
Delivery: new stacked draft GitHub PR only. Neither existing PR branch is changed; no merge/deploy.

All commands ran in the isolated worktree. `--config.verify-deps-before-run=false` prevents pnpm 11
from automatically reinstalling dependencies when running a command; it does not skip tests or
build checks. Locked dependencies were installed first; the only lockfile addition is the existing
catalog Miniflare dev dependency for the backend service-binding test. Worker tests required local
loopback permission outside the filesystem/network sandbox.

## Final focused evidence

| Command after `pnpm --config.verify-deps-before-run=false` | Result |
| --- | --- |
| `--filter @educateos/assessment-sdk test:run -- src/workshop.test.ts` | Pass, 35 tests / 4 files (the script runs the whole SDK suite) |
| `--filter @gadgets/workshop-backend exec vitest run __tests__/gadget-source-checkpoint.test.ts __tests__/gadget-restore.test.ts` | Pass, 29 workerd tests / 2 files |
| `--filter @gadgets/workshop-backend exec vitest run __tests__/assessment-blueprint.test.ts` | Pass, 3 workerd tests; actual named release service and Git packs |
| `--filter @educateos/gatekeeper exec vitest run` | Pass, 40 tests / 6 files, including 9 assessment tests with preview replacement/concurrent submit races |
| `--filter @educateos/gatekeeper exec vitest run -c vitest.worker.config.ts` | Pass, 13 workerd tests, including action-journal restart/replay/revocation |
| `--filter @educateos/district-app exec vitest run __tests__/gadget-assessment.test.ts` | Pass, 8 tests, including fake-checkpoint denial, exact Unicode source, restart/old-request replay, remote fail-closed and teacher workflow |
| `--filter @educateos/district-worker exec vitest run __tests__/district.test.ts` | Pass, 12 workerd tests, actual district service binding and SQLite restart |
| `--filter @educateos/learning-artifacts exec vitest run` | Pass, 44 tests / 8 files |
| `--filter @educateos/assessment exec vitest run` | Pass, 68 tests / 7 files |
| `--filter @educateos/portability exec vitest run` | Pass, 76 tests / 7 files; handles undisclosed assistance in Git export |
| `--filter @educateos/teacher-ui exec vitest run __tests__/gadget-assessment.test.tsx __tests__/review.test.tsx` | Pass, 11 tests / 2 files |

## Build evidence

`pnpm --config.verify-deps-before-run=false lint` passed: lint, script types, generated Worker and
production-config drift checks, and the complete workspace build (**168/168 tasks successful**).
Existing lint/bundle warnings remain; no lint or TypeScript errors remain. A direct affected-package
`tsc --noEmit` check also passed. Full workspace tests were deliberately not run.

## Fixes found during validation

- Artifact IDs have a 63-character body limit; deterministic replay IDs use 48 hex characters.
- Text artifacts normalize Unicode. The stored source envelope escapes non-ASCII code units so
  parsing preserves exact source strings and their SHA-256.
- Checkpoint verification is server-owned revision provenance, copied into submission items.
  A student-created JSON envelope or MIME type cannot mint the verified-source badge.
- Shared submission preflight checks policy, deadlines and attempts before source storage; submit
  rechecks after it. The existing separate artifact/submission transactions still permit an orphan
  course artifact after an intervening policy change or failure; retry reuses the artifact.
- The exhaustive AI-assistance case was in `educateos-portability/src/git.ts`, not artifacts-git.
  It now formats `undisclosed` without inventing a model or no-AI declaration.

Initial lint/typecheck failures in new code were fixed. One Teacher Studio review test initially
failed while its async group was loading; the isolated repeat and final combined 11-test run passed.
The final combined Gatekeeper script passed 40 Node tests then hit sandbox loopback EPERM before
starting workerd; its separate permitted workerd run passed all 13 tests. An early backend transform overlapped source edits; the stable workerd repeat passed. Expected
negative RPC cases emit workerd diagnostics; final Worker commands exited zero with passing tests.

## Scope and remaining gaps

This verifies the real boundaries separately. The district Worker test uses a synthetic trusted
release publisher; actual Workshop pack/commit verification has its own real service-binding test.
There is no single deployed browser → Gadget → Gatekeeper → district run. No full workspace test
sweep, live deployment, external conformance test or high-stakes grading was performed.

A Gadget author must implement the source-preview/user-click UI using the real RPC contract. The
trusted Workshop approval currently displays a summary, not a universal full-source viewer.
Conservative source screening cannot prove arbitrary inline code contains no private facts or
secrets; explicit source review remains necessary. AI disclosure and student explanations stay
separate evidence, with exported code marked undisclosed until reviewed. Setup/offboarding and the
optional reverse binding's bootstrap sequence are in the workflow and district Worker README.
