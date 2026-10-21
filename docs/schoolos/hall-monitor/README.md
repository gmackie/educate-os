# Hall Monitor and AI cost governance

Hall Monitor is a moderation and evaluation service shared by SchoolOS and PlayTrek. This directory
covers how SchoolOS uses it, and how SchoolOS accounts for AI spend in exact amounts.

- [`plan.html`](plan.html) is the reconciled build plan (2026-10-20). Open it in a browser.
- [`ingress-matrix.md`](ingress-matrix.md) lists every path into a model (M0), with file:line.
- [ADR-0007](../adr/0007-hall-monitor-and-ai-call-guard.md): the Hall Monitor service and the
  kernel AI call guard.
- [ADR-0008](../adr/0008-usd-nano-money.md): AI spend is counted in integer nanodollars.
- [`source/`](source/) holds the original specification set, kept unchanged for provenance. Where it
  disagrees with this README, the plan or the ADRs, those win (see below).

## What changed from the source specification

The source plan was written without some work already merged here. The plan reconciles it:

| Source said | Reconciled |
|---|---|
| Build a new ledger: price books, reserve/settle, Budget DO (M3) | Extend `@schoolos/ai-governance` (SCHO-25), which already has pools, an idempotent reserve/settle/void ledger and reconciliation. Its DO store is SCHO-73. |
| SchoolOS only has per-user daily call caps | Both exist. District USD caps live in ai-governance, which nothing in the kernel calls yet. SCHO-72 is the existing issue for the kernel hook, which moderation now shares. |
| Nanodollars throughout | Today the ledger uses whole cents and the kernel uses float dollars. Migrating to `UsdNano` (SCHO-111) is a prerequisite. |
| Intercept new chat, messages, steering and attachments | There are 14 paths. Steering, agent callbacks, `spawnAgent`, the gadget LLM binding and decision models all bypass the shared preparation step. One stream guard plus a decision-model guard covers them all (ADR-0007). |
| Extract PlayTrek's evaluators | Hall Monitor's generic evaluators are rewritten in the public repo. PlayTrek's game-specific checks stay in PlayTrek. |

## Work items

| Kanbanger | What |
|---|---|
| HM-1 … HM-5 | `gmackie/hall-monitor`: contracts and costing, policy resolver, Clef adapter, evaluators and fixtures, Worker and client |
| HM-6 | Shadow mode, launch checklist and rollback-drill tooling |
| HM-7, HM-8 | npm publishing (needs approval); human-labelled calibration (human work) |
| SCHO-110 | This documentation |
| SCHO-111, SCHO-112 | `UsdNano`, price books and per-attempt usage; protected safety pool and concurrency invariants |
| SCHO-72, SCHO-113, SCHO-114 | Kernel `AI_CALL_GUARD` seam; the `@schoolos/hall-monitor` guard; ingress coverage test |
| SCHO-73 | Durable Object ledger store |
| SCHO-115, SCHO-116 | Provider usage normalization; Cloudflare account allocator |
| SCHO-117, SCHO-118 | Admin AI governance panel; restricted safety-review workflow (gated on privacy review) |
| SCHO-119 | Move remaining AI cost fields to `UsdNano` |
| PLAY-43 … PLAY-45 | PlayTrek: usage-returning model calls, Episode Composer adapter, moderating the constructed-response judge |

## Gates that need people

A student rollout needs all of these first: legal and privacy review (COPPA, FERPA, data processing
agreements), an approved safeguarding route, Clef thresholds calibrated on human-labelled data,
least-privilege billing credentials before any live billing import, and a signed pilot checklist.
