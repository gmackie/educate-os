# Model ingress matrix (M0)

This lists every server-side path where user-supplied or external text can reach a model in
`packages/workshop-backend`. Line numbers are from `main` at 687c8e7 (2026-10-20). SCHO-114 turns
this table into a coverage test, and any new call site must be added here and to that test.

A browser user is identified in `server.ts:782-795` (`AuthenticatedApiImpl(userId)`), then
`overseer.open(userId, profileId)` (`overseer.ts:10223`) creates an `OverseerClientInterface` that
carries `clientUserId` and `clientProfileId` (`overseer.ts:11054-11062`).

| # | Path | Entry | Identity verified | Route to the model | Skips `#prepareChatMessage`? |
|---|---|---|---|---|---|
| 1 | New chat | RPC `newChat` (`overseer.ts:12130`) → `impl.newChat` (`:6564`) | `getChatContext` (`:12133`) | `#prepareChatMessage` (`:6582`) → commit (`:6606`) → `startAgent` (`:6627`). The title is also generated from the raw text (`:6635` → `completeText` `:8631`) | No |
| 2 | Chat message | RPC `sendChatMessage` (`:12139`) → `impl.sendChatMessage` (`:6673`) | same as 1 | `#prepareChatMessage` (`:6694`) → `startAgent` (`:6759`) | No |
| 3 | **Steer a running turn** | the same RPC tries a steer first (`:12146`) → `steerRunningTurn` (`:6652`) | `#getClientProfile()` only | Raw text goes into `meta.queuedSteers` (`:6661`) and is consumed by `takeSteers` (`:6930`) / `agent.ts:4308`, `#logQueuedSteers` (`:1174`) or on resume (`:1077`) | **Yes** |
| 4 | Slash-command expansion | inside `#prepareChatMessage` (`:6446-6465`) → `invokeSlashCommand` (`:6458`) | `assertGatekeeperUsable` (`:6453`) | The message produced by the gatekeeper becomes the prompt, so the check must run **after** expansion | No |
| 5 | Attachments and file references | `canonicalizeChatAttachmentRefs` (`:6581`, `:6690`), `#prepareWorkspaceAttachmentFiles` (`:6589`) | same as 1 | Bytes are inlined when history is replayed (`agent.ts:2213-2268`) | No (checked as references; content is checked at the stream guard) |
| 6 | External agent message | `ExternalMessageGateway.submitExternalMessage` (`external-message-gateway.ts:15-37`) → `receiveExternalMessage` (`overseer.ts:10369`) | `callerEmail` comes from binding props; collaborators go through `authorizeCollaborator` (`:10424-10451`) | `impl.sendChatMessage` / `newChat` (`:10497-10516`) | No |
| 7 | Scheduled task / hook | `schedule-driver.ts:410` → `GatekeeperHookLoopback.startHook` (`overseer.ts:10851`) → `startHook` (`:10615`) | hook record + vendor checks, no principal | Runs gadget code that reaches a model only through 8, 9 or 11 | n/a |
| 8 | Agent callback | `AgentSelfLoopback` (`:10882-10905`) → `deliverAgentCallback` (`:7359`) → `drainPendingAgentCalls` (`:7436-7529`) | initiator from loopback props | Arguments are written as `agentCallback` rows (`:7489-7508`), then `startAgent` (`:7529`) | **Yes** |
| 9 | Agent spawner | `AgentSpawnerBindingImpl.spawn` (`:13486`) → `spawnAgent` (`:10666`) | `creatorUserId` from props | Prompt written to `storage.chats` (`:10677-10685`), then `startAgent` (`:10689`) | **Yes** |
| 10 | Blueprint merge review | `applyBlueprint` (`:3535`) → `startAgent` (`:3644`) | `clientUserId` | Prompt is the merge record, not user text | n/a |
| 11 | Gadget LLM binding | `LanguageModelGatekeeper.startSession` (`ai-models.ts:1012`) → `run` (`:1052`) → `completeText` (`:1056`) | `props.initiator` | Prompt comes from gadget code; currently unmetered (TODO at `:1054`) | **Yes** |
| 12 | Gadget decision binding | `DecisionModelGatekeeper` (`ai-models.ts:1064`) → `decide` (`:1120`) → `getDecisionModel` (`:917`) | `props.initiator` | `workersAiClassify` (`:924`), which **does not go through `ModelHandle.stream`** | **Yes** |
| 13 | Tool and MCP results | agent loop: `webFetch` (`agent.ts:3470`), `executeCode` (`:3821`), `describeBinding` (`:3522`), `toolResult` (`:3206`) | none (output of the model's own tool calls) | Fed into the next model request | n/a (stream guard) |
| 14 | Other one-shot calls | binding names (`overseer.ts:7746`), gadget title (`:8673`), compaction (`agent.ts:4225`, `anthropic-compaction.ts:92`), admin test (`admin-settings.ts:859`) | various | `completeText` / `stream` | n/a (stream guard) |

## Chokepoints

- **Every language-model request** goes through `makeHandle().stream`, which calls `streamFn` at
  `ai-models.ts:545`. Its existing `onPayload` hook (`:534`) already rewrites outgoing payloads.
  This is the guard that cannot be bypassed.
- **Decision models** need their own guard in `getDecisionModel` (`ai-models.ts:917-924`).
- **Ingress checks** at `#prepareChatMessage` (after slash expansion), `steerRunningTurn` (before
  `:6661`), `spawnAgent` (`:10677`), agent-callback draining (`:7489`) and `LanguageModelBindingImpl.run`
  stop unmoderated text from being stored, and give the user a clear decision before a turn starts.

## Metering facts

- Usage returns via `hooks.commitAgentStep` (`agent.ts:4168`) into `addChatMessages`
  (`overseer.ts:8712`). Cache tokens are added into `meta.promptTokens` (`:8803-8809`) and appear as
  `gen_ai.usage.cache_read` / `cache_creation` in tracing (`agent-tracing.ts:64-71`).
- Per-call cost comes from pi's model catalog, or from the AI Gateway log cost when one exists
  (`#getCostFromAiGateway`, `:8855-8881`). It is accumulated as **floating-point dollars** in
  `#addChatCost` (`:8831-8846`), and the code marks it best-effort, not for billing.
- `completeText` callers (titles, binding names, the gadget LLM binding, the admin test) and decision
  models record no usage. The guard's `afterModelCall` is where they become metered.
