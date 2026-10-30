# Live capability revocation restriction — SCHO-292

Draft stacked on PR #20 (`feat/edu-policy-complete-boundaries-20261030`,
84b104ebca7fb76f5560b977b5cc674112250beb). No merge or deployment authorized.

## Security decision

Full live-capability revocation is **not implemented**. When
`WORKSHOP_CAPABILITY_POLICY` is configured, execution is now unconditionally refused,
even if policy returns allow. This deliberately restricts the parent PR's allowed execution
behavior. The parent's trusted persisted-principal checks remain intact for sharing,
publication and other protected client operations; they still revalidate every call and
fail closed on policy errors. No identity, role, payload or policy decision cache is added.
No-policy deployments retain execution, loader outbound restrictions and sharing behavior.

This restriction is separate from role revalidation: it does not interpret a district role
or claim to detect identity deletion independently of the configured policy service.
A policy adapter must reject deleted/revoked principals and unknown scopes. Execution
cannot be enabled by granting a role while this restriction remains in place.

## Boundaries restricted

- Gadget worker loading (including previews), facet acquisition and restoration, and each
  call through an existing `getGadgetFacet` root wrapper, before invoking Gadget code.
- `executeCodeMode`, including its network/tool/binding environment creation.
- Gatekeeper/binding session opening, including Gadget, worktree and agent-spawner bindings.
- Observation authorization, action submission/application (including auto-approval),
  approval, hook binding/enabling and per-firing callback checks. Removal/rejection stays available.
- Spawned-chat creation, agent-turn setup/resume, each agent pass, every model request
  (including compaction) and every tool execution. A model request already started may
  finish streaming; the next tool/model step is refused. No rollback of completed steps.

The runtime restriction checks binding presence at these boundaries, rather than borrowing
owner authority for a collaborator or trying to proxy arbitrary RPC graphs. The root wrapper
continues to allow disposal. Error text contains no prompts, code or policy records.

## Concrete surviving escape and release gates

`gadget-restore.test.ts` obtains a real workerd Gadget root, calls `mintCallback`, then
configures a policy. Root calls, loader, code and binding execution are refused, but
`callback.ping()` still returns `pong:pre-policy`. This is an intentional assertion of a
security gap, not a passing revocation claim. A raw facet/native Fetcher acquired before
restriction can similarly bypass the root wrapper; returned functions, nested stubs,
streams, persisted callbacks and already-running sandbox code are not transitively wrapped.

Existing gatekeeper sessions can perform vendor-side effects without another Workshop
approval callback. Existing git-cache capabilities, data subscriptions, pending external
jobs, browser code and previously exported capabilities may survive. An outbound fetch
or external action that has already begun is not recalled. Gadget default outbound fetch
remains denied by `globalOutbound: null`; delegated connectors remain an independent path.

**School rollout remains blocked.** Before enabling this on an existing deployment:

1. Quiesce execution and externally scheduled hooks; invalidate live Workshop sessions,
   active dynamic workers/facets, agent turns and retained descendant capabilities through
   a verified deployment-wide shutdown/restart procedure. A binding change alone is not
   proof of invalidation. Do not assume this draft performs that procedure.
2. Inventory/migrate legacy initiator attribution; never fall back to owner rights for
   school execution. Verify external gateway principal authentication and domain isolation.
3. Keep execution disabled. To restore it, implement a runtime-supported revocable
   capability graph or independently enforce revocation at every recipient, including
   descendants, native fetch, persistent restore, sessions, hooks and external services.
4. Prove principal/role/permission revocation for owner and collaborator using handles
   minted while policy was enabled and allowed; include descendant callbacks, fetch,
   streams, background/resumed agents and outstanding action races. The quarantine cannot
   mint such allowed handles, so its tests do not establish that future guarantee.
5. Address retained data subscriptions/session-token revocation and Blueprint export
   provenance identified in `workshop-policy-boundaries.md` before student access.

## Deterministic checks

The real-workerd Gadget suite exercises actual loaded JavaScript, native facets, persistent
callbacks, the explicit internet-permission denial and the surviving-descendant repro.
The agent retry suite configures policy inside an in-flight faux model response and proves
that `executeCode` is never invoked and a subsequent model request is refused. This runs
real agent machinery in workerd with synthetic content and no external model/network use.
Parent boundary tests retain coverage for caller-scoped sharing and client execution
revocation. No student records, production bindings or domain integrations are used.
