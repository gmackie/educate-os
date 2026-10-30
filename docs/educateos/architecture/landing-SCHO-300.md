# SCHO-300 PR batch integration

Integration of GitHub PRs #5–#16, preserving every original head commit in merge history.
GitHub delivery only; no ForgeGraph credential changes or manual deployments.
Production acceptance and mobile physical-device verification remain separate from code landing.

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

Fingerprints updated only for these reviewed kernel paths:

- `packages/workshop-backend/__tests__/capability-policy.test.ts`
- `packages/workshop-backend/__tests__/device-session-callback.test.ts`
- `packages/workshop-backend/__tests__/principal-sign-in.test.ts`
- `packages/workshop-backend/src/auth/device-session-callback.ts`
- `packages/workshop-backend/src/auth/principal-sign-in.ts`
- `packages/workshop-backend/src/capability-policy.ts`
- `packages/workshop-backend/src/env.d.ts`
- `packages/workshop-backend/src/server.ts`
- `packages/workshop-backend/src/user.ts`
- `packages/workshop-shared/package.json`
- `packages/workshop-shared/src/capability-policy.ts`

## Integration repairs

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

## Validation and delivery

Before merging, the integrated branch runs frozen dependency installs, full repository lint/build,
workspace tests, focused architecture/environment tests, local operations tests and mobile type/security
tests. CI validates the same combined branch before GitHub main is updated.
Inherited Cloudflare CLA storage and Bonk service failures are not fabricated as passing checks;
this fork has no configured branch-protection rules or repository webhooks at integration time.

The Launch Factory remains a labeled synthetic storyboard engine with publication disabled.
Launch Operations remains draft-only with local exports; no communications are sent.
The new MCP/Blueprint/assessment components retain their documented host authentication/persistence
and approval requirements. Code landing does not assert production readiness or completed mobile sign-in.
