# Live capability revocation — SCHO-309 (supersedes the SCHO-292 restriction)

SCHO-292 (#28) refused all execution whenever `WORKSHOP_CAPABILITY_POLICY` was bound, because a
principal deactivated or regraded in the district kept every capability already minted. SCHO-309
replaces that refusal with policy-checked execution backed by revocation **by restart**: a
principal who loses standing loses everything they hold, within a bounded delay, because the
Durable Objects hosting it are aborted. No JS proxy membrane wraps any capability.
Deployments without a policy binding behave exactly as before (no checks, no alarms, no restarts).

## Mechanism

**Standing** means: the district's live directory still has the principal as an active person of
this district (`PrincipalResolver.principalStanding`, new on `DistrictPrincipalResolver`, never
cached; a rejection or malformed answer is no standing), and the policy still allows the execution
action (`gadget.execute` / `agent.execute`) the principal was admitted for in that workspace.
`UserDurableObject.assertWorkshopStanding(workspaceId, actions)` makes both checks.

**Workspaces (Overseer).** Every entry point that lets a principal hold something in a workspace
first calls `OverseerImpl.admitPrincipal(userId, action?)`, a fresh check through that principal's
user object:

| Entry point | Admitted as | Action |
|---|---|---|
| `open()` (every client session, owner or collaborator) | the client | none (standing only) |
| Gadget client `connectToGadget`, `getUiBundle`, `getExportFormats`, `export` (build and use) | the client | `gadget.execute` |
| `newChat`, `sendChatMessage`, `retryAgent`, `applyBlueprint` | the client | `agent.execute` |
| Every agent turn at start and resume, each pass, each model request, compaction, each tool call | the turn's recorded initiator | `agent.execute` |
| Callable-agent calls (`deliverAgentCallback`), external messages | the recorded caller | `agent.execute` |
| Spawner `spawn` / `spawnCallable` | the spawner's recorded creator | `agent.execute` |
| `approveAction`, `enableHook`, gatekeeper client `openSession` | the client | `gadget.execute` |
| Auto-approvals | the user who enabled the rule | `gadget.execute` |
| Hook firings (`startHook`) | the user who enabled the hook | `gadget.execute` |

Admitted principals stay in an in-memory list for the life of the instance. Every
`STANDING_RECHECK_MS` (60 s) the alarm rechecks all of them (the alarm handler runs the same
rechecks itself while it holds the object open for agent work). Any refusal, or a check that cannot
be made, calls `scheduleAccessRestart`, which aborts the whole workspace object: every session,
gadget facet and dynamic worker, `mintCallback` descendant, raw stub, gatekeeper session, data
subscription and running turn it hosts is disposed. A fresh admission refused for something the
principal already holds there restarts the instance immediately rather than at the next recheck.
An instance with principals admitted that falls idle (no live session, no agent work) also
restarts at its recheck, rather than rechecking forever.

Beneath the entry points, every runtime seam that SCHO-292 refused (gadget loading and previews,
facet acquisition and restore, each root-wrapper call, `executeCodeMode`, gatekeeper/binding
sessions, observations, actions, hooks, git cache) now calls `assertExecutionRevocable()`: under a
policy it refuses unless this instance has admitted someone to execute and is not restarting. So
nothing executes in an incarnation the recheck does not cover.

**Users.** When a principal loses district standing, whichever check finds it
(`assertWorkshopStanding`) revokes the user: it asks every workspace the user owns or shares to
restart if it admitted them (`OverseerDurableObject.revokePrincipal`), drops the user's watched API
sessions, and restarts the user object. Workshop API sessions signed in through the principal
resolver are watched (`watchSessionStanding`): the user object holds each session's `notifyClosed`
callback and rechecks standing every 60 s; on lost standing or no answer it drops the callbacks
uncalled, and the server closes the WebSocket (the existing `notifyClosed` hack). A reconnect signs
in through `PRINCIPAL_RESOLVER` again, which refuses an inactive principal, and `open()` admits
afresh.

**Attribution.** Under a policy nothing runs on the workspace owner's rights for someone else: a
spawner without a recorded creator, a hook enabled before `enabledByUserId` was recorded, a legacy
`GatekeeperRecord.hook`, a turn without a recorded initiator and an auto-approval rule enabled by a
non-user are all refused. A user the principal migration aliased is checked as their principal
(`UserStorage.principalName`, recorded at each resolver sign-in), not as their email.

## Guarantees and bounds

- A capability minted while allowed stops working at most `STANDING_RECHECK_MS` (plus the restart's
  ~100 ms delay) after the principal is deactivated, graduated, removed, or no longer allowed,
  for owners and collaborators alike. Any next agent step, client call or reconnect is refused at
  once, since each readmits.
- A policy or district error restarts and refuses; it never allows.
- Tests (`live-capability-revocation.test.ts`, `gadget-restore.test.ts`, `agent-retry.test.ts`,
  `spawned-agent-tools.test.ts`) run real gadget facets, user and workspace objects and real
  `ctx.abort()` restarts in workerd with synthetic data: a root stub, its `mintCallback`
  descendant and a spawner gatekeeper session minted while allowed fail after deactivation; the
  recheck alarm is scheduled within the bound; a reconnect and the callable-agent entry are refused;
  a policy error restarts; a running turn stops before its next tool and model request.

## What remains

- **Effects already begun are not recalled.** A model request already streaming, an outbound vendor
  call, an applied action or a gatekeeper-side side effect completes; a restart only ends what the
  workspace hosts. Gatekeeper vendors are bound by their session contract, not by this mechanism.
- **The bound is a delay, not an instant.** Between rechecks a principal who has not touched the
  workspace keeps idle capabilities up to 60 s. A restart disrupts everyone else connected to that
  workspace (they reconnect), as collaborator removal already does.
- **Admission is per instance, not per capability.** The backstop refuses execution only when no one
  is admitted. Inside an incarnation where some principal is admitted to execute, a capability minted
  for one person can be exercised by whoever holds it until the next restart; the entry points above
  are what attribute execution. A persistent restore stub held outside the workspace (for example by
  a vendor) restores into whatever incarnation is running.
- **Standing without a resolver.** With a policy but no `PRINCIPAL_RESOLVER`, only the policy's
  answers are rechecked; sessions are not watched, and a principal admitted only to hold a session is
  never re-asked.
- **Other objects.** Capabilities hosted outside workspace and user objects (gatekeeper Workers'
  own state, scheduler driver rows, the district's own sessions and devices) are not restarted.
  Hook firings re-admit their enabler at each `startHook`.
- **Data visibility is not execution.** Reading a workspace or listing it is gated by sharing, not by
  `gadget.execute`; a principal in standing whom the policy refuses execution can still open shared
  workspaces. Blueprint export provenance and redaction remain as in
  [workshop-policy-boundaries.md](workshop-policy-boundaries.md).

## Production ordering

Deploy the district Worker (with `principalStanding` and the workspace action grants) before the
backend that binds `WORKSHOP_CAPABILITY_POLICY`; an older district rejects `principalStanding`, which
counts as no standing and restarts everything. Set `DISTRICT_CONFIG.workshopPolicy` (including
`workspaceActions`) before or with the backend deploy, or the district denies every mint and
execution.
