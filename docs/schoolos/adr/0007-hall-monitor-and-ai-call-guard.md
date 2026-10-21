# ADR-0007: Hall Monitor service and the kernel AI call guard

- Status: Accepted
- Date: 2026-10-20
- Issue: SCHO-110 (plan); implementation in SCHO-113, SCHO-114 and SCHO-72

## Context

Student-facing AI needs a mandatory moderation step that cannot be skipped by any route into a model.
PlayTrek needs the same capability for generated learning content. The SchoolOS M0 inventory
([ingress matrix](../hall-monitor/ingress-matrix.md)) found 14 server-side paths that reach a
model. Three of them bypass `#prepareChatMessage`: steering a running turn, agent callbacks and
`spawnAgent`. Decision models bypass `ModelHandle.stream` entirely.

SchoolOS already has a reserve/settle ledger (`@schoolos/ai-governance`, SCHO-25), but nothing in
`workshop-backend` calls it yet (SCHO-72).

## Decision

1. **Hall Monitor is a separate, product-neutral service** in `gmackie/hall-monitor`. It is a
   Cloudflare Worker with a TypeScript SDK, and both SchoolOS and PlayTrek call it. It returns
   findings, a deterministic decision (`allow`, `coach`, `hold`, `block`, `support`) and a
   content-free cost receipt. It never authorizes data access or awards grades.
2. **Deployment follows the bill.** A district runs its Hall Monitor Worker in its own Cloudflare
   account and reaches it through a service binding. A managed tenant reaches it over HTTPS with a
   signed, short-lived service JWT. No moderation path goes through `schoolos.dev`.
3. **One kernel seam.** The kernel gains a single optional hook, `AI_CALL_GUARD`. It is called
   before and after every model call: in `makeHandle().stream`, in `getDecisionModel`, and at the
   ingress points where a clear user-facing error matters (`#prepareChatMessage` after slash
   expansion, `steerRunningTurn`, `spawnAgent`, agent-callback draining and the gadget LLM binding).
   The hook receives content-free metadata plus only the messages added since the last check. When
   it is unbound, upstream behaviour is unchanged. This is the same seam SCHO-72 needs for the
   `AiRequestGovernor`.
4. **The guard lives outside the kernel.** `@schoolos/hall-monitor` implements it. It reserves
   against `AiLedger`, sends new messages to the Hall Monitor client, settles each attempt and
   applies the decision. Policy logic never enters `workshop-backend`.
5. **Mandatory moderation has its own funding.** Hall Monitor spend draws on a district `safety` pool
   (SCHO-112), never on a student's or teacher's generative allowance. When the safety pool is
   exhausted, generative AI stops and a non-AI path is offered. Moderation is never skipped to save
   money.
6. **Failure behaviour depends on the audience.** If Hall Monitor is unavailable, student-facing
   modes fail closed and offer a support path. Educator-only modes may follow an approved
   deterministic fallback.
7. **Hall Monitor is public, so it is written from scratch.** ADR-0006 permits extracting PlayTrek
   code into public SchoolOS packages, but Hall Monitor's generic evaluators are written fresh
   against neutral contracts, and PlayTrek's game-specific evaluators stay in PlayTrek behind an
   adapter.

## Consequences

- The kernel diff is one interface plus a handful of call sites, reviewed on its own (SCHO-72).
- An ingress coverage test (SCHO-114) fails CI whenever a new model call site has no guard
  declaration.
- Moderating every agent step would re-check the whole transcript. The guard therefore tracks, per
  chat, which messages have been moderated, and caches results by content digest, policy revision
  and evaluator version.
- Student modes that need output screening buffer the model's output until it is released.
  Educator modes keep streaming.

## Note (2026-10-21, ADR-0011)

- There is no SchoolOS-hosted Hall Monitor. Rule 2's "managed tenant" over HTTPS does not exist:
  every organization runs its Hall Monitor Worker in its own Cloudflare account
  ([ADR-0011](0011-open-source-charter-and-module-ownership.md)). The AI call guard reaches it
  through the `HALL_MONITOR` service binding, or over HTTPS at `HALL_MONITOR_URL`, which then names
  that organization-run Worker.
- Only the Hall Monitor client and contracts tarballs are vendored and pinned today
  ([`vendor/hall-monitor`](../../../vendor/hall-monitor/README.md)). The Worker itself is built
  from `gmackie/hall-monitor` outside the SchoolOS release. Shipping a pinned, auditable Worker
  build in the release is a known gap (RFC 0002 §12, IF-00b).
