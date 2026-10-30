# SCHO-301 integration validation

Base: origin/main b4157a242e6580211280a6ab66972eac82483e9f. Candidate: draft PR #24, branch feat/edu-architecture-integration-20261030. No merge or deploy.

**School rollout and educator/student authoring are DISABLED / blocked.** Generic Workshop remains default-off for school mode. Signed access-school assets select an enforced backend profile, not proof of safe functionality. REQUIRE_WORKSHOP_CAPABILITY_POLICY is set independently on the backend, bound to DistrictWorkshopCapabilityPolicy, and missing authority denies HTTP/RPC; installer refuses absent district service or wrong authority target.

## Signed-configuration acceptance criteria

Before enabling teacher/student authoring, every publication, sharing, Gadget and agent execution action must have an explicit district ABAC mapping from fresh verified principal and approved, persisted Blueprint/workspace provenance. Unknown actions must deny. The present adapter deliberately denies workspace.create.query, gadget.create, blueprint.import, blueprint.publish, workspace.share, gadget.execute and agent.execute, even for district admins. Do not broaden its mint-only grants to make the UI work. A dedicated direct-Worker regression protects these denials. A school deployment may create an inert workspace but cannot execute or author through these paths. SchoolShell admin-only Advanced Workshop does not fulfill educator/student authoring.

The concrete live principal resolver and school release binding are now integrated and verified in focused workerd tests. Revocation of retained raw stubs and running sessions, approved Blueprint/Gadget catalog integration, a shared authoritative district directory and approval queue for MCP, complete browser/capability credential audit, and end-to-end signed school activation are rollout blockers until separately verified. MCP transport source wiring and metadata tests do not resolve its independent directory/approval store ownership. No production signing key, credential or data was used.

## Initial validation and limits

- School/frontend profile: 5/5 tests passed; script types passed.
- Early Workshop workerd: 4 files, 35 tests passed (policy, direct RPC, principal sign-in, explicit no-public-egress runtime). This predates later integrations and the final HTTP regression.
- Initial synthetic G0/G1 report: **exit 124**, idle limit 120s / total limit 600s, elapsed 124.6s. No individual scenarios emitted by quiet report.ts reporter. G0/G1 is **not green**. Exact command and process diagnostics: pilot-initial.log.
- Initial district/LTI focused workerd: **exit 124**, idle limit 120s / total 600s, elapsed 156.8s. No scenario result. Script stopped on this failure; subsequent package tests in that initial chain did not run. See district-initial.log.
- Reruns use explicit bounded 300s idle / 600s total, and one worker for the diagnostic pilot and district tests. Keep initial timeout evidence even if narrower reruns pass.
- An early workspace build raced dependency synchronization and failed with missing module/tsc links. Clean installed-dependency rerun is required; the earlier failure is not evidence of a source regression or a pass.

## Integrated follow-ups

All seven explicitly named follow-ups were available and integrated: policy completion 84b104eb, district adapter bf6febdd, MCP OAuth Worker 5a4b4d1a, Blueprint persistence e5e9aac6, live principal resolver b74fb321, classroom authoring discovery 8a9b6d04, and execution restriction 51836e1e. Existing production configs have no diff. The resolver and policy entrypoints both survive reconciliation. Environment selector and --profile school alias select the same signed profile; conflicting values reject.

Execution restriction 51836e1e does **not** implement transitive revocation. Every configured-policy execution path is intentionally refused even when an adapter allows it. Raw descendants acquired before policy activation remain a documented escape; this is a rollout blocker. The authoring discovery vocabulary is also denied by the district adapter; no teacher/student authoring is enabled. The added direct-Worker denial test includes workshop.authoring.query.

## Result matrix

| Check | Result |
| --- | --- |
| pnpm lint (including script types/config drift/workspace build) | PASS, 167/167 tasks; final code revision 9bd982d8 |
| Standalone pnpm build | PASS, 167/167 tasks before final authoring/revocation; final lint rebuilt affected source |
| Final Workshop workerd | PASS 6 files / 55 tests, including scoped discovery, mandatory HTTP/RPC denial, principal login, egress and execution restriction |
| Release/profile/inventory Node suite | PASS 27 tests |
| Explicit kernel inventory against pinned upstream 0483e888 | PASS 0 unmatched kernel differences; each new path has specific rationale |
| District policy + principal resolver + LTI workerd | PASS 3 files / 28 tests; includes intentional authoring denial, current directory/revocation and malformed identity |
| MCP unit + Worker | PASS 21 unit + 3 workerd tests; metadata, trusted registry, identity/tenant denial and queued writes |
| Catalog | PASS 71 unit + 4 workerd tests; restart/tenant checks |
| Installer | PASS 34 tests; final school activation additions PASS 12-test desired-state suite |
| Router | PASS 19 tests |
| School shell | PASS 12 tests |
| Identity | PASS 93 tests |
| AI guard | PASS 89 tests |
| G0/G1 initial reporter | FAIL exit 124, idle 120s, elapsed 124.6s |
| Pilot verbose diagnostic | FAIL exit 124 at total 600s, elapsed 600.2s; incomplete suite |

The verbose pilot identified: §14 District B request to district A resource, first HTTP scenario timed out at 30000ms; §14 Semester end / graduation, graduating student's grants scenario expected a 401 unauthenticated among results but got two 403 forbidden results. These are real unresolved test failures, not a green synthetic pilot. Multiple existing TODO scenarios also remain blocked (including SCHO-107 private chat/feedback, SCHO-90 export, SCHO-108 real backup, accessibility issues). The diagnostic emitted named passing scenarios as well, but the suite never completed within the bound.

The final fresh six-file Workshop run passed 55 tests (workshop-final.log). An intermediate Workshop run during authoring integration failed 2 tests with getWorkshopAuthoringCapability missing from the loaded runtime (38 passed); the fresh final six-file run supersedes that intermediate mismatch and is recorded separately. Runtime import/transform can outlast the default idle watchdog; that explains why narrow reruns were given explicit longer bounds, not an excuse to discard failures.

 Passing package tests alone do not establish school production readiness.

GitHub CI at code head 9bd982d8: CLA failed, upstream-delta passed, package CI pending. No CI completion, approval, merge, deployment, real Access session, signed full release bundle or live school rollout is claimed. No production signing keys were read. Manifest/signature checks use synthetic test fixtures. Full workspace tests were not run; focused tests are enumerated above.

Final vocabulary regression initially expected a returned denial for workshop.authoring.query, but generated capnweb-validate rejected that intersection union first (TypeError). No authority was granted. The regression now requires either explicit deny or that exact validation rejection, and independently checks the real domain adapter denies each action. The original failure is preserved in disabled-actions-initial.log; it documents a discovery compatibility blocker, not an authorization bypass. Domain action grants remain unchanged.

Final corrected district/resolver/LTI run: exit 0, 3 files / 28 tests passed (42.03s), including domain and RPC refusal of all authoring vocabulary. No permissions were broadened.
