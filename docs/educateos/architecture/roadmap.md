# Product fork PR roadmap

Separate owning-project issues and narrowly scoped PRs are required for each track.
These are handoff criteria, not implementations authorized by this branch. Use
synthetic district fixtures; preserve educational features during all migrations.

| Sequence / track | Deliverable | Acceptance criteria |
| --- | --- | --- |
| 1 / governance (this branch) | Inventory, manifest, CI, ADR | Reports reproduce by SHA; exact kernel content gate; rename/removal tests; no runtime edits. |
| 2 / delta ownership audit | Map every kernel path to callers and owner | Each entry has retain/extract/upstream disposition, issue, compatibility evidence; distinguish upstream-only drift. No behavior changes. |
| 3 / domain contracts | Consolidate existing educational vocabulary | No duplicate IDs, principals, scopes or grade authorities; consumer type checks and serialization compatibility pass. |
| 4 / security contracts | Map all student/agent ingress | Cross-district, inactive-principal, replay, revoked-capability and AI guard-failure tests deny access; no migration bypass. |
| 5 / integrations | Vendor behavior behind existing gatekeepers | OAuth/reconnect compatibility, revocation/replay tests and provider fakes pass; no self-asserted ambient capability or deployable library. |
| 6 / shell | Product-owned education presentation | Existing workflows remain reachable; accessibility/route tests pass; server authorization and RPC compatibility preserved. |
| 7 / kernel extension | Only remaining general-purpose extension points | Separate kernel/shared review slice; validated documented RPC exports; stub lifecycle/pipelining evidence; security tests and file-specific rationale/review. |
| 8 / upstream reconciliation | Import upstream in isolated branch | Review rename/deletion drift; regenerate configs from source; product/security regression checks pass; delta shrinks or increases are explained. |
| 9 / release evidence | Separately authorized assembled-fork validation | Exact-revision required checks; staging compatibility and rollback evidence; production closure only after deployment/health verification. No merge/deploy in this branch. |

Contracts and security evidence precede caller migration. Delete old behavior only
when every caller is migrated and compatibility tests pass. This inventory cannot
replace per-feature security review. Production and credential work require separate
authorization. Existing educational features remain in place throughout.
