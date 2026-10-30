# Model ingress matrix (M0)

This lists every server-side path where user-supplied or external text can reach a model in
`packages/workshop-backend`. Line numbers are from `main` at 687c8e7 (2026-10-20).

SCHO-114 made the table a coverage test. Each row names the `AiCallSite` label the AI call guard
receives for it, and the test that drives it with a guard bound (tests are in
`packages/workshop-backend/__tests__/`). Every kernel call that obtains a model (`getModel`,
`getDecisionModel`) or names its own call site carries an `// ai-call-site: <labels>` marker, and
`ai-call-sites.test.ts` fails when a call has no marker, names a label the union lacks, or differs
from its manifest. A new call site therefore changes that manifest, this table, and
`ai-call-ingress.test.ts`.

An agent turn is labelled by what started it, set where the turn starts (`startAgent`) and kept in
its `ActiveAgentRecord` so a resumed turn keeps it. `chat.agent` is what remains: a retry, a
blueprint merge review, or a turn resumed from a record made before the label was kept. All of a
chat's agent-turn labels, compaction included, share one record of the messages already shown to
the guard, so a turn with a new label passes only what is new.

A browser user is identified in `server.ts:782-795` (`AuthenticatedApiImpl(userId)`), then
`overseer.open(userId, profileId)` (`overseer.ts:10223`) creates an `OverseerClientInterface` that
carries `clientUserId` and `clientProfileId` (`overseer.ts:11054-11062`).

| # | Path | Entry | Identity verified | Route to the model | Skips `#prepareChatMessage`? | AI call site | Covered by |
|---|---|---|---|---|---|---|---|
| 1 | New chat | RPC `newChat` (`overseer.ts:12130`) → `impl.newChat` (`:6564`) | `getChatContext` (`:12133`) | `#prepareChatMessage` (`:6582`) → commit (`:6606`) → `startAgent` (`:6627`). The title is also generated from the raw text (`:6635` → `completeText` `:8631`) | No | `chat.message` (turn), `chat.title` (title) | `ai-call-ingress.test.ts` "new chat (row 1)" |
| 2 | Chat message | RPC `sendChatMessage` (`:12139`) → `impl.sendChatMessage` (`:6673`) | same as 1 | `#prepareChatMessage` (`:6694`) → `startAgent` (`:6759`) | No | `chat.message` | `ai-call-ingress.test.ts` "chat message (row 2)" |
| 3 | **Steer a running turn** | the same RPC tries a steer first (`:12146`) → `steerRunningTurn` (`:6652`) | `#getClientProfile()` only | Raw text goes into `meta.queuedSteers` (`:6661`) and is consumed by `takeSteers` (`:6930`) / `agent.ts:4308`, `#logQueuedSteers` (`:1174`) or on resume (`:1077`) | **Yes** | `chat.steer` for the turn a steer prompts (at turn end, or on resume); a steer read mid-turn arrives in the running turn's next step under that turn's label | `ai-call-ingress.test.ts` "steer (row 3)" |
| 4 | Slash-command expansion | inside `#prepareChatMessage` (`:6446-6465`) → `invokeSlashCommand` (`:6458`) | `assertGatekeeperUsable` (`:6453`) | The message produced by the gatekeeper becomes the prompt, so the check must run **after** expansion | No | the turn's label (`chat.message`, `chat.external`) | rows 1 and 2 (the expanded message is what the guard sees); no separate test |
| 5 | Attachments and file references | `canonicalizeChatAttachmentRefs` (`:6581`, `:6690`), `#prepareWorkspaceAttachmentFiles` (`:6589`) | same as 1 | Bytes are inlined when history is replayed (`agent.ts:2213-2268`) | No (checked as references; content is checked at the stream guard) | the turn's label; content is passed as `image` parts with a digest | no separate test |
| 6 | External agent message | `ExternalMessageGateway.submitExternalMessage` (`external-message-gateway.ts:15-37`) → `receiveExternalMessage` (`overseer.ts:10369`) | `callerEmail` comes from binding props; collaborators go through `authorizeCollaborator` (`:10424-10451`) | `impl.sendChatMessage` / `newChat` (`:10497-10516`) | No | `chat.external` | `ai-call-ingress.test.ts` "external agent message (row 6)" |
| 7 | Scheduled task / hook | `schedule-driver.ts:410` → `GatekeeperHookLoopback.startHook` (`overseer.ts:10851`) → `startHook` (`:10615`) | hook record + vendor checks, no principal | Runs gadget code that reaches a model only through 8, 9 or 11 | n/a | the label of the binding it reaches (rows 8, 9, 11, 12) | rows 8, 9, 11, 12 |
| 8 | Agent callback | `AgentSelfLoopback` (`:10882-10905`) → `deliverAgentCallback` (`:7359`) → `drainPendingAgentCalls` (`:7436-7529`) | initiator from loopback props | Arguments are written as `agentCallback` rows (`:7489-7508`), then `startAgent` (`:7529`) | **Yes** | `agent.callback` | `ai-call-ingress.test.ts` "agent callback (row 8)" |
| 9 | Agent spawner | `AgentSpawnerBindingImpl.spawn` (`:13486`) → `spawnAgent` (`:10666`) | `creatorUserId` from props | Prompt written to `storage.chats` (`:10677-10685`), then `startAgent` (`:10689`) | **Yes** | `agent.spawn` (first turn; later turns are `chat.message`) | `ai-call-ingress.test.ts` "agent spawn (row 9)" |
| 10 | Blueprint merge review | `applyBlueprint` (`:3535`) → `startAgent` (`:3644`) | `clientUserId` | Prompt is the merge record, not user text | n/a | `chat.agent` | manifest only |
| 11 | Gadget LLM binding | `LanguageModelGatekeeper.startSession` (`ai-models.ts:1012`) → `run` (`:1052`) → `completeText` (`:1056`) | `props.initiator` | Prompt comes from gadget code; currently unmetered (TODO at `:1054`) | **Yes** | `gadget.llm` | `ai-call-ingress.test.ts` "LLM binding (row 11)", at the gatekeeper DO without its facet |
| 12 | Gadget decision binding | `DecisionModelGatekeeper` (`ai-models.ts:1064`) → `decide` (`:1120`) → `getDecisionModel` (`:917`) | `props.initiator` | `workersAiClassify` (`:924`), which **does not go through `ModelHandle.stream`** | **Yes** | `gadget.decision` | `ai-call-ingress.test.ts` "decision binding (row 12)", at the gatekeeper DO without its facet |
| 13 | Tool and MCP results | agent loop: `webFetch` (`agent.ts:3470`), `executeCode` (`:3821`), `describeBinding` (`:3522`), `toolResult` (`:3206`) | none (output of the model's own tool calls) | Fed into the next model request | n/a (stream guard) | the turn's label | `ai-call-guard.test.ts` "asks the guard before each step" (tool results in `newMessages`) |
| 14 | Other one-shot calls | binding names (`overseer.ts:7746`), gadget title (`:8673`), compaction (`agent.ts:4225`, `anthropic-compaction.ts:92`), admin test (`admin-settings.ts:859`) | various | `completeText` / `stream` | n/a (stream guard) | `chat.binding-name`, `gadget.title`, `chat.compaction`, `admin.model-test` | `ai-call-ingress.test.ts` "binding name", "workspace title" (at the methods that make them) and "compaction" (`runAgent` on a `/compact` turn); the admin test by the manifest only |

## Chokepoints

- **Every language-model request** goes through `makeHandle().stream`, which calls `streamFn` at
  `ai-models.ts:545`. Its existing `onPayload` hook (`:534`) already rewrites outgoing payloads.
  This is the guard that cannot be bypassed.
- **Decision models** need their own guard in `getDecisionModel` (`ai-models.ts:917-924`).
- **Ingress checks** at `#prepareChatMessage` (after slash expansion), `steerRunningTurn` (before
  `:6661`), `spawnAgent` (`:10677`), agent-callback draining (`:7489`) and `LanguageModelBindingImpl.run`
  stop unmoderated text from being stored, and give the user a clear decision before a turn starts.

## Background cache warming

Upstream can keep a provider's prompt cache warm by resending the last frozen payload while a
chat is idle. That resend bypasses `ModelHandle.stream` and cannot honor fresh guard instructions,
so `guardModelHandle` withholds its `lastRequest` capability whenever `AI_CALL_GUARD` is bound,
including requests captured after the stream finishes. Ordinary prompt caching during guarded
model calls remains enabled. Deployments without a guard retain upstream cache warming.
`ai-models.test.ts` drives a real provider response with cache usage and verifies that guarded
handles never expose a resend, while the adjacent unguarded tests exercise upstream resending.

## Output screening (SCHO-133)

The rows above are about what reaches a model. What a model sends back is screened at one place,
the stream guard (`guardModelHandle` in `ai-call-guard.ts`), so every row that streams from a
language model (all but row 12) is covered alike:

- When `beforeModelCall` answers `{ action: "proceed", screenOutput: true }`, the guarded stream
  forwards nothing while the model answers. Once the response is complete it calls
  `screenModelOutput(callId, { parts })` with the response's text blocks and its unredacted
  reasoning, which the Workshop shows the user, as text parts. `release` replays the held events
  exactly; `withhold` ends the stream with the same error a denial does (so
  `throwIfAiCallDenied()` and the turn's error path treat it as one), and none of the response is
  forwarded.
- Tool calls are not screened: a response with no text is released without asking, and a
  response's tool-call arguments are passed on with its text when that is released. Their
  effects reach a model again as tool results, which `beforeModelCall` moderates as input.
- A guard that asks for screening and then fails, times out (15 s), lacks `screenModelOutput`, or
  is still screening when the call is stopped has the response withheld. Without `screenOutput`
  the stream is unchanged and nothing is buffered.
- Decision models (row 12) are never screened: their answers are probabilities read by gadget
  code, not text shown to a person.
- `screenModelOutput` runs before `afterModelCall`, so a withheld response is still settled with
  the usage the provider billed.

## Request instructions (SCHO-135)

A `proceed` decision may also carry `instructions`, plain text of at most
`MAX_AI_CALL_INSTRUCTIONS_LENGTH` (4,000) characters; longer is an invalid decision and denies the
call. The stream guard appends them to that one request as a final `system` message after the
newest message (pi's "additional instructions"), so the cached prompt prefix is unchanged. They are
never added to the agent's transcript, stored in the chat's history, shown to the user, or passed
back to the guard as a new message. Decision models ignore them. The EducateOS guard uses them to
coach a learner on a `coach` decision.

The EducateOS guard asks for screening when the resolved profile's `outputModeration` is `required`
(student profiles), and screens with Hall Monitor's `interaction.output`, funded from the safety
pool.

## Metering facts

- Usage returns via `hooks.commitAgentStep` (`agent.ts:4168`) into `addChatMessages`
  (`overseer.ts:8712`). Cache tokens are added into `meta.promptTokens` (`:8803-8809`) and appear as
  `gen_ai.usage.cache_read` / `cache_creation` in tracing (`agent-tracing.ts:64-71`).
- Per-call cost comes from pi's model catalog, or from the AI Gateway log cost when one exists
  (`#getCostFromAiGateway`, `:8855-8881`). It is accumulated as **floating-point dollars** in
  `#addChatCost` (`:8831-8846`), and the code marks it best-effort, not for billing.
- `completeText` callers (titles, binding names, the gadget LLM binding, the admin test) and decision
  models record no usage. The guard's `afterModelCall` is where they become metered.
