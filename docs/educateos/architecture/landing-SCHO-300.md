# SCHO-300 PR batch integration

Integration of GitHub PRs #5–#26, #28 and #29, preserving all 24 original feature heads,
GitHub main's upstream sync and canonical Forgejo history with merge commits.

## Canonical production landing

The user selected Forgejo main as the canonical destination. GitHub main is only a mirror;
never merge a GitHub PR into it. Forgejo main `c7810e4f` has been merged into this branch.
The batch must land LAST, after Forgejo #167, #183, #208, #210, #214, #215, #217, #218,
#223, #224 and #233 have merged or been explicitly deferred. Fetch and merge latest canonical
main again after that train; all three checks (`CI / ci`, `CI / mobile`, `CI / workshop-tests`)
must pass for that exact head before approval and merge. Pending, stale, cancelled and failed
checks do not qualify. Use `forge pr approve`, then a merge commit, never squash or rebase.

A canonical main merge automatically deploys production. Record the merge SHA, ForgeGraph
deployment ID and health evidence before completing SCHO-300. Only then fast-forward GitHub
main without force and reconcile GitHub PRs #5–#29 with a canonical merge link.

## Canonical conflict decisions

- Preserve the canonical mobile router, device credentials, one-origin pairing, themes and
  platform links. The older native entrypoints were superseded by canonical's Expo router;
  remove the obsolete copies. Retain validated linking/RN version corrections.
- Keep both immutable Gadget assessment storage and canonical device/pairing/ops stores.
- Share one fresh-directory principal resolver and its separate explicit migration matcher.
  Corrupt/revoked links refuse sign-in without exposing directory records. Keep both test suites.
- Keep production's staged `PRINCIPAL_MIGRATION` cutover; do not auto-enable principal identity
  for existing email-keyed accounts. Explicit school release profiles require principal/policy
  authority. Canonical migration uses upstream's `listWorkspaces`/`newWorkspace` API.
- Preserve canonical `/ai` routing, public-path links and district frame/context validation.
  Add the external MCP route only for its exact allowlisted paths.
- Generic releases retain `access` and `access-ai`; school releases carry `access-school` and
  `access-school-ai` with explicit school flags. The installer selects the matching mount and
  retains optional OSS admin resources. Regenerate the release golden from composed config.
- Keep Cloudflare upstream's unified Drive picker and Forgejo's Classroom student connector.
- PR #28 intentionally disables policy-bound execution; raw descendant capability revocation
  is still unavailable. Required-but-missing policy also refuses retained execution paths.
- PR #29's Google bridge is draft-only and validated against offline fake HTTP, never live Google.

## Kernel review

The integrated kernel diff was inspected against the root and backend AGENTS.md and REVIEW.md.
The new policy uses the persisted user identity, checks authority immediately before existing mints,
preserves the disabled-binding path and retains the existing resource-enabled checks. No parallel
credential store, self-declared ambient resource, or mirrored RPC interface was added.
The public capability types and their members are documented; token/provider credentials are excluded
from policy descriptors. Denial text is explicitly trusted safe-to-show policy-service output.

Principal assertions require finite unexpired expiry before resolution. Device callbacks authenticate
when either Access or a principal resolver is configured; absent Access config denies before redemption.
The native redirect origin is deployment configuration, restricted to canonical HTTPS and kept separate
from request input. Single-use encrypted transfer and principal ownership checks remain intact.

The stacked assessment bridge reads only exact public stored Git packs, checks the commit and hashes
sorted source files. Its public RPC contract is documented and exposes no Gadget runtime state.
The extended optional policy checks retained RPC clients before publication, sharing, execution and
agent entrypoints; its creation query is advisory and mutations still authorize independently.
Existing raw stubs, running/resumed turns and legacy initiator attribution remain school-rollout
blockers. The district policy adapter conservatively denies the new operation scopes it does not
recognize; binding enablement requires a separate reviewed rollout.

Fingerprints updated only for these reviewed kernel paths:

- `packages/workshop-backend/__tests__/assessment-blueprint.test.ts`
- `packages/workshop-backend/__tests__/capability-boundaries.test.ts`
- `packages/workshop-backend/__tests__/capability-policy.test.ts`
- `packages/workshop-backend/__tests__/gadget-restore.test.ts`
- `packages/workshop-backend/__tests__/device-session-callback.test.ts`
- `packages/workshop-backend/__tests__/principal-sign-in.test.ts`
- `packages/workshop-backend/src/auth/device-session-callback.ts`
- `packages/workshop-backend/src/auth/principal-sign-in.ts`
- `packages/workshop-backend/src/auth/config.ts`
- `packages/workshop-backend/src/blueprint-archive.ts`
- `packages/workshop-backend/src/capability-policy.ts`
- `packages/workshop-backend/src/overseer.ts`
- `packages/workshop-backend/src/env.d.ts`
- `packages/workshop-backend/src/server.ts`
- `packages/workshop-backend/src/user.ts`
- `packages/router/src/index.ts`
- `packages/workshop-backend/wrangler.production.jsonc`
- `packages/workshop-shared/package.json`
- `packages/workshop-shared/src/api.ts`
- `packages/workshop-shared/src/capability-policy.ts`

The final three PRs add explicit required-policy enforcement at HTTP and retained RPC boundaries,
a concrete district-owned principal resolver, and read-only authoring discovery. Missing required
resolver/Access/policy configuration refuses access. Both principal and policy entrypoints/tests
are retained through merge conflict resolution. Password/gatekeeper fallbacks remain disabled in
required principal mode. Router MCP paths are exact and conditional on an explicit service binding.
The generated district production config adds the principal binding; it has not been deployed.

## Integration repairs

- School CLI/environment selectors now resolve once, reject contradictory settings, and consistently select school assets, principal authentication and capability-policy wiring. School dev also binds the principal resolver.
- Added the external MCP fixture bundle and reviewed the corresponding golden release-manifest entry after PR #24 made it deployable.
- Non-mutating sorting and exported declaration documentation satisfy the repository lint rules.
- The school presentation flag is explicitly accounted for as a VITE_* build-cache input.
- Revoked principals now fail authentication (401), while an active unenrolled principal still receives 404; the district test distinguishes both.

## Heads included

- [PR #5](https://github.com/gmackie/educate-os/pull/5): `6ebd654be5911b0b397deb3d6b17bdbfcc659d5a`
- [PR #6](https://github.com/gmackie/educate-os/pull/6): `1319dd31288fae645035f923e21af470d6c1d4a1`
- [PR #7](https://github.com/gmackie/educate-os/pull/7): `1e42faea72622310160158fb21c9a1149279425c`
- [PR #8](https://github.com/gmackie/educate-os/pull/8): `289916564a597c09662d4a76a17d541303786649`
- [PR #9](https://github.com/gmackie/educate-os/pull/9): `93fbca00542dcbba32954a47a3cb293c9e34be99`
- [PR #10](https://github.com/gmackie/educate-os/pull/10): `83d0e8881c02fcb115f17cf325c7d33eb3a28a3f`
- [PR #11](https://github.com/gmackie/educate-os/pull/11): `27b51a6374bf7a1e203f0a1ffeee2ce6dc20d8ef`
- [PR #12](https://github.com/gmackie/educate-os/pull/12): `04eb03017a6739281bd050fe4a95971b8aa9ffc2`
- [PR #13](https://github.com/gmackie/educate-os/pull/13): `8386a5e0b2473f504f66373aac6387f076446f06`
- [PR #14](https://github.com/gmackie/educate-os/pull/14): `9b8cb87a0f790f73072c79cc99b4cb26bc57f98a`
- [PR #15](https://github.com/gmackie/educate-os/pull/15): `1290bef7639184e74c370e97ae488488bd608479`
- [PR #16](https://github.com/gmackie/educate-os/pull/16): `b75c0a9e02691a21b1d894d26c9ed5da3f0b9bfa`

- [PR #17](https://github.com/gmackie/educate-os/pull/17): `45c82639d66e96e3af7bc892f2b1ca7f035cbf4c`
- [PR #18](https://github.com/gmackie/educate-os/pull/18): `17472c2f64b22e40894a2f086eef2d057402c96f`
- [PR #19](https://github.com/gmackie/educate-os/pull/19): `b4f56537d1a736fd35d70fe6cd5156bf8c6abee8`
- [PR #20](https://github.com/gmackie/educate-os/pull/20): `84b104ebca7fb76f5560b977b5cc674112250beb`
- [PR #21](https://github.com/gmackie/educate-os/pull/21): `5a4b4d1aff3db73a874c4b8f9027b03b0d1ac96c`
- [PR #22](https://github.com/gmackie/educate-os/pull/22): `bf6febdda61ab4f1c32a6e136ba2c841322f1c0e`
- [PR #23](https://github.com/gmackie/educate-os/pull/23): `e5e9aac6fcd88be594e706824eee7dcc87a5aceb`

- [PR #24](https://github.com/gmackie/educate-os/pull/24): `b69ad039cd1be37b911b57432b56abe00dd747ed`
- [PR #25](https://github.com/gmackie/educate-os/pull/25): `b74fb32145cbd444e9c450a3e4fac662ee0cbaca`
- [PR #26](https://github.com/gmackie/educate-os/pull/26): `8a9b6d04d4fb5ed991f7a9b24d73f40f277b66e3`

## Validation and delivery

The initial 12-PR integration passed frozen dependency installation, full repository lint/build
(172 tasks), 27 focused architecture/environment/operations tests, 13 district course tests, mobile
typecheck and 20 mobile security tests. The real local relay security test passed independently.
Workspace attempts stopped on a 60-second relay startup timeout under load, then on the historical
upgrade fixture build's 60-second idle watchdog; neither attempt is claimed green.

After adding the next seven PRs, the 19-PR integration passed frozen installation,
`pnpm lint` (172/172 build tasks), 71 focused offline/loopback tests and the kernel inventory gate
with zero unreviewed deltas. The final PR records combined-head CI results; GitHub main is updated only after code
checks pass. The Launch Factory's original CI includes 82-scene smoke capture and a full V01 draft.
Inherited Cloudflare CLA storage and Bonk service failures are not fabricated as passing checks;
this fork has no configured branch-protection rules or repository webhooks at integration time.

The Launch Factory remains a labeled synthetic storyboard engine with publication disabled.
Launch Operations remains draft-only with local exports; no communications are sent.
The new MCP/Blueprint/assessment components retain their documented host authentication/persistence
and approval requirements. Code landing does not assert production readiness or completed mobile sign-in.

Public website intake and opt-out collection remain disabled by default. The persistent catalog and
MCP resource Worker require their documented trusted-host/installer wiring; no live route is enabled.

The final 22-PR integration additionally validates the unified release selector, combined manifest,
production configuration and both concrete district principal/policy entrypoints. Final PR CI is the
combined-revision merge gate; prior feature CI is supporting evidence only.

Final local checks passed: full `pnpm lint` (172 tasks), 45 release/profile/manifest/production-config
tests and all 99 district Worker tests, including both merged authority service entrypoints.
Focused backend real workerd regressions passed all 52 tests across five merged boundary suites.

CI repair: account for directly invoked school-dev `DISTRICT_CONFIG` as an external environment
input. Mobile dependency compatibility is checked with Expo; no new exclusions or disabled checks.

CI follow-up validation: Expo compatibility passed after updating only `expo-linking` to 58.0.15
and React Native to 0.88.1 with the isolated lockfile regenerated. Mobile frozen install, typecheck,
20 security tests, public config validation and both iOS/Android source exports passed. The four
environment-contract checks passed. CLA Assistant still lacks its signatures branch; Bonk setup
aborts before review. Neither failure is represented as passing or disabled. Merge hold remains.


## Canonical integration validation

Local validation after merging `c7810e4f`:

- Frozen root and isolated mobile installs; `pnpm lint`, generated development/production config
  checks, and all 181 workspace build tasks pass.
- 81 release/config/environment tests and 159 installer tests pass, covering generic/school
  assets, root and `/ai` mounts, optional OSS admin and authority requirements.
- District Worker: all 132 real-workerd tests pass, including device/pairing, current directory
  sign-in, roster sync, policy and immutable Gadget assessment behavior.
- Backend: 73 focused policy, callback, restore and agent tests pass; six canonical migration
  tests pass after adapting to upstream workspace API and expiring synthetic assertions.
  Another 74 canonical guard/mount/context/handoff/directory tests pass.
- Router: 100 tests pass. Mobile: typecheck, 60 tests and both iOS/Android Hermes exports pass.
- Operations: 56 offline tests pass, including Google draft-only bridge adversarial cases.
- Video: ten safety/unit tests, all 82 synthetic scene smoke checks and the full narrated V01
  MP4 end-to-end test pass; browser escape attempts fail closed. Publication remains disabled.
- Architecture inventory is bound to reviewed blob fingerprints; zero unreviewed kernel changes.
  Both histories' source/shotlist bytes remain identical to `feat/launch-factory-20261030`.

These local results do not substitute for the three exact-head canonical CI jobs, latest-main
refresh after the other PR train, or verified production deployment. No GitHub main update,
production merge, live Google operation, paid model call or outreach send has occurred here.

Canonical CI run 815 exposed a student Classroom picker merge error: the Drive duplicate-name
helper was called with course options. A new workerd regression reproduced the crash, then passed
with the existing Classroom helper; both student and teacher role filters remain isolated. The
earlier local cached build did not detect this error; fresh package typechecks and an uncached
workspace build are required for this repair. The run's mobile and Workshop jobs were skipped,
despite their success-shaped commit statuses, so they do not count as completed gates.

Launch Factory run 816 stopped before tests because Ubuntu returned a mismatched optional Mesa
archive. Its isolated Forgejo workflow now omits recommended GPU packages for CPU-only rendering
and retries downloads, retaining apt signature/hash verification. Host CI must verify the Linux
installation and full V01 render. GitHub CLA storage and Bonk service errors remain non-canonical.

Repair validation: fresh Google source/test typechecks, all 79 configurator workerd tests, ten
video safety/unit tests, root `pnpm lint`, and workspace `vp run --no-cache` build (181/181 tasks)
pass. All 24 feature heads and both original main heads remain ancestors; source asset bytes are
unchanged. The earlier successful video E2E is supporting local evidence, not proof that the new
Linux dependency installation passed. Await the current-head Forgejo run before landing.

GitHub run 41047927944 exposed one further pilot-gate expectation mismatch, reproduced on the
canonical integration: graduation retires the principal, so the current directory resolver returns
`401 unauthenticated` before class authorization. The graduation scenario now requires that exact
result for retained and freshly issued credentials, proves the student was authenticated before
graduation, and retains the revoked-grant, retained-work and teacher-access assertions. The shared
403/404 denial helper and production authentication code are unchanged. Its aggregate “Build and
test” job failed only because the package test job failed.

Graduation repair validation: full pilot-gate suite passes (142 tests, 23 existing TODOs), fresh
pilot source/test typecheck passes, and root lint/build passes all 181 tasks. No production
identity/policy code changed; these results still require new exact-head canonical CI.
