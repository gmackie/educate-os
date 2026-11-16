# Learning activity adapters (SCHO-423)

A library for explicitly shared project evidence in the Personalized Learning Planner. It adds no
Worker, route, UI, network listener, executable tool discovery or automatic mastery inference.
It is stacked on [PR #394](https://git.forgegraf.com/gmackie/educate-os/pulls/394), branch
`SCHO-420-personalized-learning-planner`. The adaptive planner and parent/teacher workflow workstreams
can consume it without changing this package's engine adapters.

## Run it

From the repository root, with its pnpm dependencies installed:

```sh
pnpm --filter @educateos/activity-adapters test:run --maxWorkers=1
pnpm --filter @educateos/activity-adapters exec tsc --noEmit
pnpm --filter @educateos/activity-adapters example
```

The executable Pizza Tycoon example uses the **real runtime, consent policy, Studio adapter and
evidence verifier** with a fake local companion. It prints a clearly simulated user approval,
the exact companion call (`studio_id`, reviewed scenario/revision, two clients), and a digest-pinned
bundle. Server/test surfaces respond; the deliberately missing client surface makes coverage
`partial`. It neither starts Roblox nor calls any service. The fixture is district-authored,
with **no standards alignment**; its numbers are instructional, not real Roblox observations.

## Contract and trust boundaries

1. The trusted host installs adapters with `ActivityRuntime.register`. Duplicate IDs fail.
   `capabilities()` lists individual actions and their surfaces. Registration is a code/plugin trust
   boundary; never expose it as a student or model tool. Descriptors cannot make untrusted code safe.
2. `ActivityRequest` selects an installed adapter/action/operation, run UUID, explicit session,
   ownership scope and pinned revision, required surfaces, assistance, and the existing registry
   `EvidenceContract`. There is no arbitrary script, URL, tool name, credential or approval boolean.
   Schema validation is strict. `observe`, `collect-evidence`, `run-scenario`, and `mutate` are separate.
3. `sessionAuthority()` denies everything by default. A trusted user interaction can issue an exact
   scope/action allowlist expiring within one hour. Every request rechecks the host's `allowed`
   callback: authenticated session, enrollment, project ownership, district policy and the pinned
   catalog approval. Reads/collection use explicit session consent. Every scenario or mutation also
   requires a new `approveSideEffect` interaction for its exact immutable request/digest. Consent
   expires during dialogs and is revocable. Neither teachers nor school services impersonate the
   user's Roblox account. A host must not construct consent from student-supplied JSON.
4. Before an adapter runs, a replay store atomically claims `(district, runId)`. Repeated or concurrent
   requests cannot execute twice. An uncertain transport failure stays consumed; inspect it before
   requesting a new run. `MemoryReplayStore` is for tests/local processes; production requires durable
   atomic claims and retention through the session/replay window. Storage failure fails closed.
5. Evidence records request and source/adapter/producer provenance, session, revision, assistance,
   consent receipt, start/end times and each surface's actual capture time/status. Scalar measurements
   and digest-pinned artifact handles are the only observation payloads. No raw logs, private chats,
   credentials, clinical/SEL measurements, inferred mood or behavioral student profiles belong here.
   “Behavioral evidence” means observable **project behavior** such as counts, timing or assertions.
   Hosts/companions must allowlist measurement names and sanitize artifacts; numeric schema validation
   alone cannot prevent a malicious producer encoding private information.
6. `complete` means all requested surfaces answered; **it does not mean the tests passed, the surfaces
   agree, or the student learned**. Inspect false assertions and divergent values. Missing surfaces,
   empty responses, wrong revisions, stale times, unsupported features and errors cannot silently pass.
   In this protocol, capture timestamps must be within the run; synchronize a real companion's clock
   or translate its timestamps at the trusted boundary without concealing original artifact times.
7. SHA-256 uses the assessment SDK's canonical JSON. `verifyEvidence` checks shape, integrity and
   consistency. **A digest is not a signature.** `acceptEvidence` also requires the host's exact
   expected request, a separately authenticated producer receipt/signature for the entire bundle
   digest, and an atomic ingestion replay claim. Never implement `authenticate: () => true` for uploads.
   The demo compares an out-of-band fixture receipt; production pairing/signing is not implemented.

`TeacherVerification` and `verifyWithTeacher` preserve an append-only, digest-bound teacher record.
The callback must authenticate an active class teacher, evidence producer and current contract
approval; a posted teacher ID grants no access. Verification requires a **separate independent
assessment**, its response digest, a fresh assessment context/time, rationale and every pinned
criterion. A working game, photo, generated code or AI-written explanation alone is refused.
A later independently assessed response does not erase assistance on the original project. Every
record says `changesProficiency: false`; it is input to the existing planner review process, never a
grade/mastery write. Corrections append new records; this library does not persist or overwrite them.

## Practical Gadget adapter

`gadgetAdapter({scope, paths, source})` accepts a restricted
`Pick<Overseer, 'readFilesAtCommit'>`, derived from the real Workshop API. Pass a capability from the
user's already-authorized Workshop session, select specific project files, and pin the actual
40-character Git commit. The host must check those files belong to the authorized project; possession
of a workspace RPC capability alone is broader than this activity's scope. The adapter reads only
those paths, computes content hashes, and emits source evidence without executing code or copying
source into the evidence bundle. The host retains/disposes the RPC stub; the adapter borrows it.

Missing response entries are explicitly unavailable (the API can omit paths due to its response
budget). Absent/unreadable/large streamed files never become a green empty read. All returned streams
are cancelled, including when another requested file is absent. Select smaller files or use the
separate reviewed artifact flow for large data. Gadget runtime driving is **unsupported**: no existing
sanctioned browser scenario API was found that this package could safely treat as student execution.
Another adapter may implement fixed browser scenarios behind the same consent boundary.

## Roblox Studio / LevelForge companion integration

The official docs were read from Roblox's public creator-docs source on 2026-11-15:

- [Studio MCP](https://create.roblox.com/docs/studio/mcp): local **stdio**, explicit `studio_id` on
  tool calls, read tools such as `script_read`, `get_studio_state`, `search_game_tree` and
  `inspect_instance`; effectful tools include `multi_edit`, `execute_luau`, and `start_stop_play`.
- [StudioTestService](https://create.roblox.com/docs/reference/engine/classes/StudioTestService):
  `ExecuteMultiplayerTestAsync` is **plugin-only**, at most eight clients, one test session per Studio,
  not callable inside a running test. `start_stop_play` starts a single Play Client session and does
  not substitute for the multiplayer plugin API.
- [Studio-mediated Open Cloud](https://create.roblox.com/docs/studio/mcp-open-cloud): `open_cloud_invoke`
  uses permissions granted by the Roblox user per published game, enforced by Studio. The client
  cannot grant itself scopes or see credentials. This adapter exposes **no Open Cloud call**.

Real setup, to be implemented by a trusted user-controlled companion (the separate LevelForge
workstream owns its runner):

1. Install current Roblox Studio locally and open **your own authorized place**. In Assistant →
   Manage MCP Servers, enable Studio as MCP server. Connect a trusted local MCP client using Studio's
   displayed configuration. Current documented macOS command:
   `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`; Windows:
   `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`. Do not launch either command from a remote Worker.
2. In the companion, use `list_roblox_studios` and have the user choose the exact Studio window/place.
   Bind `sessionId`, `studioId`, district/student/project scope and an actual content revision/digest.
   A display name or “latest” is not a revision. The companion must revalidate the selected instance,
   place ownership and current revision before every request. An edit/reconnect needs a new binding
   and consent; it must not silently follow a different game or window.
3. Show explicit session read/evidence consent. For every scenario show the reviewed scenario ID,
   version, clients, place/revision, scope and side effects and obtain fresh local user approval.
   Revalidate approval at the companion immediately before dispatch; remote host permission alone
   cannot authorize a local tool. Do not expose a raw MCP proxy to students or the cloud service.
4. Implement the exported `StudioCompanionTransport` methods. **This is a companion contract, not a
   fabricated official MCP wire schema.** Use the installed MCP `tools/list` input/output definitions
   and translate the response to the strict `Observation[]` schema. Every method includes a full
   binding, `studio_id` and `runId`. Scope/session mismatches must refuse without tool calls.
5. `observe` calls only `get_studio_state`; it must never start play, run scripts, read console/chat,
   or use `execute_luau` as a fallback. `collect` reads opt-in structured instruments for the named
   activity and sanitizes them. Missing server/client/test instruments return unavailable/unsupported,
   not made-up values. Raw `get_console_output` is not automatically ingested because it may contain
   private student text. Script/tree reads can be separate explicitly consented future actions.
6. Optional `runPluginScenario` is a **companion/plugin port**, not an MCP tool named after
   StudioTestService. The user installs/reviews the plugin and fixed scenario code in their own place.
   The plugin calls `ExecuteMultiplayerTestAsync(clients, reviewedArgs)` and reports structured test,
   server and client evidence. It must verify scenario revision, serialize per Studio, handle busy
   sessions, bound execution time, and stop/clean up only the test session it owns on timeout/cancel.
   No student-provided Luau, raw tool names, code edits, publishing or third-party game mutation.
7. Preserve per-surface capture times, revision and provenance in the response; transport exceptions
   become sanitized errors. The producer receipt must bind the returned digest to this session's
   chosen Studio instance/source. Send evidence only through an explicitly paired/authenticated,
   district-authorized channel. Roblox cookies/API keys stay out of EducateOS, bundles and fixtures.

The in-package bridge is executable and tested with a fake local transport. It is **not** a shipped
local companion, MCP client, Roblox plugin, live Studio integration or automatically reachable
remote service. It implements no arbitrary Luau, `multi_edit`, `save_place`, `open_cloud_invoke`,
auto-publishing or direct secret-bearing Roblox HTTP requests. The engine-neutral mutation contract
is tested with a fake adapter and stays unavailable on the real Gadget/Studio adapters.

## Integration with the existing planner/activity APIs

Reuse the approved opportunity's `contract` exactly. Its `CompetencyRef`s pin registry revisions;
`ActivityAuthority.allowed` must recheck district approval/hidden-node policy and project access.
Keep the opportunity's existing catalog release digest and provenance in planner storage; do not
mint a parallel standards registry or invent CASE GUIDs here. `contract` plus the complete request
is hashed in each bundle. Curriculum installations use `student.getActivity`; private source reads
still require their own Workshop capability and explicit sharing.

The baseline `student.plannerShare` accepts **text and assistance**, not this structured bundle.
Do not pass a bundle as if that route already supported it. A future host integration should store
the authenticated bundle in a district-owned evidence store, attach its opaque digest/ID to a
voluntarily shared planner response with optimistic concurrency, and preserve the teacher policy in
`teacher.plannerReview`. Later independent responses must follow the baseline's new-plan rules;
do not rewrite an already reviewed response or relabel AI assistance as independent. No such
persistence/UI glue is claimed in this PR. An LTI launch establishes identity/context only; neither
launching an external tool nor receiving an LTI score proves independent mastery or authorizes local
Studio execution. Existing district policy still owns class, student and teacher access.

## Cross-domain examples

- **Roblox Pizza Tycoon:** predict oven A's rate from 12 pizzas/3 min, then 80 pizzas/20 min; compare
  oven B at 15/5 and 60/20. Capture server counts, client-visible state and explicit test outcomes.
  Missing client state makes the evidence partial. Ask the student to explain units, assumptions and
  a fresh unseen rate problem. On approved grade-6 opportunities use the baseline's real 6.RP.A.3
  node and 6.RP.A.3b component contract; the synthetic executable fixture claims no alignment.
- **TF2Heatmaps-style profiling:** use sanctioned, anonymized demo telemetry for a local project,
  not game account access or player chat. Pin input replay/dataset and analysis-code revisions;
  collect aggregate frame time, sample counts and chosen spatial bins with explicit units. Compare
  hotspots and explain sampling bias, denominator choice and whether a changed rendering improves
  measured performance. A pretty heatmap or a fast renderer is project evidence; a teacher needs
  the learner's independent explanation. This is a documented future adapter, not a shipped TF2 tool.
- **Sports:** voluntarily share distance and time for a drill, a worksheet with units and any adult
  assistance. No GPS tracking, faces or automatic recording. A coach/teacher checks the actual
  measurement method and the learner solves a fresh speed/unit-conversion task independently.
- **Baking/crafts:** `OfflineSubmission` records performed time, explanation, measurements, opaque
  artifact digests and explicit assistance/sharing. Compare 12 cookies/$6 with 20/$8, explain yield,
  cost per cookie and scaling; or compare fabric area and waste. A photo shows an artifact, not who
  understood ratios. Teacher verification requires a separate criterion-based assessment.

Read-only inspiration came from `gmackie/testgame`'s `dev/gameprobe/README.md` and
`dev/gamedrive/gamedrive.test.mjs`, and `gmackie/levelforge`'s `packages/mcp-server/src/tools.ts`
(Game Admin observe/catalog, explicit drive writes, client reports and persistent tapes). GameProbe's
separate server/client/frame/log evidence and “the surface actually answered” rule motivate this
contract. GameDrive's clamp/queue tests motivate explicit effect boundaries. No code or settings
were changed in either repository. No claim is made that their full protocol is implemented here.
