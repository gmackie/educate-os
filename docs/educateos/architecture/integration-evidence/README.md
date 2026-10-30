# SCHO-301 integration validation

Base: origin/main b4157a242e6580211280a6ab66972eac82483e9f. Candidate: draft PR #24, branch feat/edu-architecture-integration-20261030. No merge or deploy.

**School rollout and educator/student authoring are DISABLED / blocked.** Generic Workshop remains default-off for school mode. Signed access-school assets select an enforced backend profile, not proof of safe functionality. REQUIRE_WORKSHOP_CAPABILITY_POLICY is set independently on the backend, bound to DistrictWorkshopCapabilityPolicy, and missing authority denies HTTP/RPC; installer refuses absent district service or wrong authority target.

## Signed-configuration acceptance criteria

Before enabling teacher/student authoring, every publication, sharing, Gadget and agent execution action must have an explicit district ABAC mapping from fresh verified principal and approved, persisted Blueprint/workspace provenance. Unknown actions must deny. The present adapter deliberately denies workspace.create.query, gadget.create, blueprint.import, blueprint.publish, workspace.share, gadget.execute and agent.execute, even for district admins. Do not broaden its mint-only grants to make the UI work. A dedicated direct-Worker regression protects these denials. A school deployment may create an inert workspace but cannot execute or author through these paths. SchoolShell admin-only Advanced Workshop does not fulfill educator/student authoring.

A concrete live principal resolver binding, revocation of retained raw stubs and running sessions, approved Blueprint/Gadget catalog integration, a shared authoritative district directory and approval queue for MCP, complete browser/capability credential audit, and end-to-end signed school activation are rollout blockers until separately verified. MCP transport source wiring and metadata tests do not resolve its independent directory/approval store ownership. No production signing key, credential or data was used.

## Initial validation and limits

- School/frontend profile: 5/5 tests passed; script types passed.
- Early Workshop workerd: 4 files, 35 tests passed (policy, direct RPC, principal sign-in, explicit no-public-egress runtime). This predates later integrations and the final HTTP regression.
- Initial synthetic G0/G1 report: **exit 124**, idle limit 120s / total limit 600s, elapsed 124.6s. No individual scenarios emitted by quiet report.ts reporter. G0/G1 is **not green**. Exact command and process diagnostics: pilot-initial.log.
- Initial district/LTI focused workerd: **exit 124**, idle limit 120s / total 600s, elapsed 156.8s. No scenario result. Script stopped on this failure; subsequent package tests in that initial chain did not run. See district-initial.log.
- Reruns use explicit bounded 300s idle / 600s total, and one worker for the diagnostic pilot and district tests. Keep initial timeout evidence even if narrower reruns pass.
- An early workspace build raced dependency synchronization and failed with missing module/tsc links. Clean installed-dependency rerun is required; the earlier failure is not evidence of a source regression or a pass.

Final result matrix and additional logs will be appended as checks finish. Passing package tests alone do not establish school production readiness.
