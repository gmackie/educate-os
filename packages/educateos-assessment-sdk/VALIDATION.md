# Local validation — 2026-10-30

Node 24.14.0, pnpm 11.17.0. `--config.verify-deps-before-run=false` skips pnpm's automatic
shared-store status/write check in this restricted worktree; dependencies were installed first.
It does not disable tests, type checks, lockfile validation or any application policy.

| Exact command | Result |
| --- | --- |
| `pnpm --config.verify-deps-before-run=false --filter @educateos/assessment-sdk test:run` | 30 tests passed: runtime/contracts/blueprints, pure CI adapter, actual EducateOS service bridge |
| `pnpm --config.verify-deps-before-run=false --filter @educateos/assessment-sdk-react test:run` | 7 view behavior tests passed |
| `pnpm --config.verify-deps-before-run=false exec vp run -F @educateos/assessment-sdk -F @educateos/assessment-sdk-react build` | Both typechecks passed; final repeat replayed matching cache entries |
| `pnpm --config.verify-deps-before-run=false lint` | Passed lint, script types, generated-config checks, production-config checks and workspace build: 168/168 tasks successful |
| `pnpm --config.verify-deps-before-run=false exec vp lint packages/educateos-assessment-sdk packages/educateos-assessment-sdk-react` | Passed focused lint after final edits |
| `pnpm --config.verify-deps-before-run=false --workspace-concurrency=2 -r --filter @educateos/assessment --filter @educateos/assessment-ci --filter @educateos/assessment-ai --filter @educateos/learning-artifacts --filter @educateos/quizzes --filter @educateos/ocs exec vitest run` | 282 existing Node tests passed: 68 assessment, 58 CI, 38 AI, 44 artifacts, 27 quizzes, 47 OCS |
| `pnpm --config.verify-deps-before-run=false --filter @educateos/assessment-sdk quickstart` | Both synthetic districts evaluated; retry matched; cross-district evidence denied |
| `pnpm --config.verify-deps-before-run=false --filter @educateos/assessment-sdk pack --pack-destination /private/tmp` | ESM JavaScript, declarations and README packed successfully |
| `pnpm --config.verify-deps-before-run=false --filter @educateos/assessment-sdk-react pack --pack-destination /private/tmp` | React ESM JavaScript and declarations packed successfully |
| `pnpm --dir /private/tmp/assessment-sdk-consumer install --offline --ignore-scripts` then `node /private/tmp/assessment-sdk-consumer/smoke.mjs` | Clean tarball install: core evaluation works without any Cloudflare/EducateOS optional peers; five UI exports load and three render |
| `git diff --check` | Passed |

For the clean consumer, install both local tarballs plus React/react-dom 19.2.8. The UI's core SDK
dependency is versioned after packing, so before registry publication use a temporary
`pnpm-workspace.yaml` override pointing `@educateos/assessment-sdk` at the local core tarball.
Copy `examples/consumer-smoke.mjs` into that consumer as `smoke.mjs` and run it there. The temporary
consumer installed six packages total (two SDK packages, Zod, React, React DOM, scheduler).

The complete workspace `pnpm test`, separate workerd test configurations, browser application
integration and remote CI were not part of this focused validation. No existing production source
was changed. This is local verification, not production health evidence, registry publication,
standards certification, executable Gadget release verification or sandbox security assurance.
