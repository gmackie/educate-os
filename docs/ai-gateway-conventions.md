# Cloudflare AI Gateway conventions

Shared by PlayTrek and EducateOS. Each product keeps its own copy and its own
implementation (EducateOS ADR-0006: no code is imported across the boundary).
What is shared is this contract, so that gateway dashboards, spend limits, and
log tooling read the same in both. Change both copies together.

Reference implementations:

- PlayTrek: `packages/ai/src/gateway/index.ts` (raw `fetch` clients and the
  Workers AI binding).
- EducateOS: `packages/workshop-backend/src/ai-gateway.ts` and `ai-models.ts`
  (`getModel()`).

## Gateways

One gateway per product and environment. Never share a gateway between
products: spend limits, rate limits, and caching are per gateway, so a burst in
one product would throttle the other.

| Product | Environment | Gateway id |
| --- | --- | --- |
| PlayTrek | beta | `playtrek-beta` |
| PlayTrek | production | `playtrek-prod` |
| EducateOS | district installs | created per account by `educateos-installer` |

Gateway settings:

- **Authenticated.** Every HTTPS request carries
  `cf-aig-authorization: Bearer <token>`. Workers AI binding calls are
  authenticated in-account and need no token.
- **Request and response bodies are not logged by default.** Both products
  serve minors (COPPA / FERPA). A feature that needs prompt logging opts in per
  request with `cf-aig-collect-log: true`, with a written reason. Turning on
  body logging for a whole gateway needs a decision recorded on the tracking
  issue.
- **Spend limits** keyed on the `feature` metadata, plus one cap for the whole
  environment.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CF_AI_GATEWAY` | Gateway id. Unset means every provider goes direct, exactly as before the gateway existed. |
| `CF_AI_GATEWAY_ACCOUNT_ID` | Cloudflare account that owns the gateway. Required once `CF_AI_GATEWAY` is set. Missing is a configuration error, not a silent fallback to direct calls. |
| `CF_AI_GATEWAY_API_TOKEN` | Token with AI Gateway Run (and Read, for cost lookups) on that gateway. Required for any HTTPS provider that is routed. |
| `CF_AI_GATEWAY_PROVIDERS` | Comma-separated providers to route. Empty means none. PlayTrek treats an unknown name as a configuration error. |
| `CF_AI_GATEWAY_USE_BINDING` | EducateOS only: send gateway traffic over the Workers AI binding instead of HTTPS. |

Rollout is one provider at a time by adding it to `CF_AI_GATEWAY_PROVIDERS`.
Rollback is removing it, or unsetting `CF_AI_GATEWAY`.

## Provider ids

Use the gateway's own path segment. Aliases are accepted so one value works in
both products.

| Gateway path | Accepted aliases | Provider |
| --- | --- | --- |
| `openrouter` | | OpenRouter |
| `openai` | | OpenAI |
| `anthropic` | | Anthropic |
| `google-ai-studio` | `google` | Gemini |
| `elevenlabs` | | ElevenLabs |
| `workers-ai` | `cloudflare` | Workers AI |

Use **provider-native gateway paths**
(`https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/…`),
not the `/compat` unified endpoint, unless a decision says otherwise. The
native paths keep each provider's request shape, so routing is a base-URL swap.
Provider keys still travel on each request until stored keys (BYOK) are
adopted.

## Metadata (`cf-aig-metadata`)

At most five entries per request (gateway limit).

| Key | Required | Value |
| --- | --- | --- |
| `app` | yes | `playtrek` or `educateos`. Set by the product's base config; callers cannot override it. |
| `env` | yes | `beta`, `production`, … Set by the base config; callers cannot override it. |
| `feature` | recommended | snake_case product surface, e.g. `generation_stream`, `world_genesis`, `npc_voice`. The spend-limit key. |
| `request_id` | optional | Opaque correlation id. EducateOS uses `educateos_request_id` for ledger reconciliation. |

Never put names, emails, free text, or other PII in metadata. It is stored in
gateway logs and used as spend-limit bucket keys. Use opaque ids only.

## Cost

Each gateway response carries `cf-aig-log-id`. Store it with the generation
record, then read the real cost from the gateway log asynchronously, retrying
with backoff and falling back to the local estimate. EducateOS does this in
`overseer.ts`. PlayTrek returns `gatewayLogId` on OpenRouter completions;
persisting and reconciling it is phase 3 of PLAY-46.
