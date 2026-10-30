# External school-tools MCP API

`@educateos/external-mcp` is an independent Fetch API package for a district-owned Worker.
It imports no Workshop kernel/UI or Cloudflare runtime modules. `createSchoolMcpApi(...)`
returns `{ fetch(request) }`, usable from a Worker's fetch handler or a district Durable Object.
This branch does not register a deployment, expose an endpoint on the production router, or
supply an OAuth authorization server. SCHO-174 owns authorization-server/discovery rollout.

## Composition and trust

Pass the district's existing `SchoolToolRunner` (the same curated tools, policy engine and
**durable approval queue** used by its HTTP/LTI application), district ID, exact allowed
browser origins, and a `SchoolTokenAuthority`. The authority takes explicit issuer, asymmetric
algorithm, key resolver, MCP audience and distinct exchange audience configuration. Key URLs
must come from trusted configuration, never token headers. Resolve the current directory on
**every** `resolver()` call using `createDirectoryPrincipalResolver(snapshot)`. Its issuer/sub
link determines identity; token roles, email, principal IDs and district IDs have no authority.
The runner rechecks stored resource targets and current district policy on every call.

Use `DurableTokenStore` over one district Durable Object's transactional storage. Assertion
claims must be atomic across all isolates: KV or process-local Maps are unsuitable. Access
secrets are random 256-bit bearers stored only as SHA-256 keys. Revoke a grant by its stored
digest. Signed JWT access tokens expire within five minutes; immediate unlinking or issuer
removal in the directory also revokes their identity mapping. Direct JWT revocation by jti is
not implemented; use opaque exchange grants if per-token revocation is required. Host storage
retention should purge expired grants and assertion tombstones only after their expiry.

All tool calls set `confirmWrites: true`. An absent approval queue fails closed. `readOnlyHint`
is display metadata, never authorization. External definitions clear the internal district
`readOnly` confirmation bypass: only this registry's explicit `read`/`list` actions run immediately;
unclassified actions require confirmation. MCP cannot approve or decline anything: a person
uses the existing HTTP approval surface, which re-authorizes the queued call. Catalogs contain
only tool definitions (never records); hosts must curate them to exclude sensitive operations.
No tool output, access token or private record is logged by this package.

## Wire profile

Implemented: MCP **2025-11-25** Streamable HTTP, POST `/mcp`, JSON responses, initialize,
notifications/initialized, ping, tools/list and tools/call. Stateless operation requires no
session ID; GET/SSE and DELETE are unsupported (405). Clients send both `application/json`
and `text/event-stream` in Accept, and `MCP-Protocol-Version: 2025-11-25` after initialization.
An unsupported initialize version negotiates 2025-11-25. Batch requests and unknown fields
are rejected. Bodies are bounded to 64 KiB. No CORS headers are emitted; browser hosting must
use the same origin. Requests with an unapproved Origin are refused.

POST `/token` accepts a strict JSON token-exchange request:

```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "subject_token": "<signed assertion>"
}
```

This is a narrow server-to-server **JSON exchange profile**, not a general RFC 8693 OAuth token
endpoint (no form encoding, client registration or PKCE). The trusted issuer must issue this
assertion specifically for the exchange audience, with `typ: JWT`, `sub`, `iat`, `exp`, and a
unique `jti`, with a lifetime at most five minutes. One assertion can be exchanged exactly once.
A signed access JWT instead needs `typ: at+jwt` and the MCP audience; an LTI launch id_token is
not an MCP access token. Existing LTI broker validation and principal mapping remain unchanged.
Opaque access grants expire no later than their assertion and are resolved against current
identity links on each request. Every response carrying tokens, tool data or errors is no-store.

Protocol 2026-07-28, authorization code/PKCE, protected-resource metadata, authorization-server
discovery, and public routing are outside this narrowly scoped package. Do not advertise those
capabilities until their separate integration is complete.

## Checks

`pnpm --filter @educateos/external-mcp test:run`

`pnpm exec vp run -F @educateos/external-mcp build`

Also run the existing LTI identity and validation regressions; they verify that launch roles
and custom principal claims cannot turn a student into a teacher.

## District Worker follow-up (SCHO-294, stacked on #15)

The package now includes `src/worker.ts`: an independently deployable district-owned Worker and
`McpDistrict` SQLite Durable Object. It reuses `SchoolTokenAuthority`, `SchoolToolRunner`, district
policy, durable directory stores and durable human approval storage. There is no central
credential authority. It exposes `/mcp`, the existing narrow JSON `/token` exchange, public
`/.well-known/oauth-protected-resource/mcp` (and root alias), and GET `/healthz`. Health checks
configuration and routing only; it does not assert issuer availability or database readiness.
The wire protocol remains the tested 2025-11-25 stateless JSON profile. No 2026-07-28 support
is claimed. The sections above describe the parent library; the Worker adds discovery and CORS.

Configure **private** `MCP_CONFIG` as JSON with these fields (do not commit real student records):

- `origin`: exact public HTTPS origin; the access-token audience is exactly `<origin>/mcp`.
- `directory`: a valid `DistrictDirectorySnapshot`, including district trusted issuer and
  issuer/subject links. Seeded once into local durable storage; subsequent requests read current
  records. This Worker owns a separate district store: do not deploy a stale replica of an existing
  district directory and treat it as synchronized. Installer integration must choose one authoritative
  store and wire current roster/policy administration plus human approvals before enabling tools.
- `allowedOrigins`: exact HTTPS browser origins (empty permits non-browser clients only).
- `issuer`: `issuer`, `metadataUrl`, `jwksUri`, `exchangeAudience`, `algorithms` (RS256, PS256,
  ES256 or EdDSA) and `credential` (`person` or `service`). All URLs are HTTPS without query,
  fragment or userinfo. Metadata and JWKS must share the configured issuer origin. Discovery
  requires an exact issuer and JWKS match plus a same-origin token endpoint; redirects fail.
  No URL comes from unverified token headers/claims. Discovery failure fails closed with a generic
  503 and can retry; it never logs configuration, tokens, claims or directory contents.

Both access JWTs and exchange assertions require signed `scope` containing `mcp:tools`.
Opaque grants retain those verified scopes. A scope permits transport access only; current
identity links and district ABAC remain authoritative. Access JWTs use `typ: at+jwt` and the MCP
resource audience; exchange assertions use `typ: JWT` and the distinct exchange audience.
Tokens expire within five minutes. Refresh tokens are neither issued nor accepted: clients
refresh with the configured district authorization server and present its new access JWT. A
new token cannot restore an inactive/unlinked principal. Local opaque revocation is available
through `DurableTokenStore.revokeAccess`; there is deliberately no unauthenticated admin endpoint.
The district authorization server owns login/PKCE, refresh, consent and client registration;
this Worker advertises that issuer, never pretends to be an authorization server.

The Worker catalog is an explicit subset of academic operations: school/term/course/offering
reads, own enrollments, roster and update_course. A server-owned allowlist maps
read/list operations to trusted `read`/`list` actions and update_course to `update`. Targets come
from stored records and handlers re-authorize them; readOnlyHint and body metadata never decide
execution. Unknown classifications default to `invoke-tool` and require confirmation.
Every write requires durable human confirmation; MCP has no approve endpoint. Until the district
approval UI/service and authoritative roster updates are wired, queued calls cannot be applied.
The existing optional LTI handler remains separate and unchanged; no LTI launch token is accepted
as an MCP access JWT. Do not mount LTI under `/mcp` or bypass its existing validation.

401 challenges identify the canonical protected-resource metadata URL and required scope, with
no error detail or echoed bearer. Exact allowed origins get CORS headers and bounded preflight
permissions; wildcard origins, cookie credentials, null origins and unexpected headers are refused.
Absent Origin is supported for non-browser clients. Public metadata includes no school records.
The Worker disables observability; application responses and tokens are no-store.

### Standalone configuration and installer handoff

The source of truth is `deploy/cloudflare.config.ts`; regenerate with
`pnpm --filter @educateos/external-mcp configs:generate`. Tests compare its generated
`deploy/wrangler.jsonc` byte-for-byte. This nested config deliberately avoids automatic Workshop
release discovery: `manifest-lib.ts` cannot classify this standalone Worker without a new service
registration and would require backend binding/installer changes. That separate integration belongs
to SCHO-174; it must include private configuration provisioning, authoritative district storage,
approval/roster administration, local revocation and retention cleanup, hostname routing and health
verification. No Workshop files, shared release manifest or existing district Worker are changed.

For an operator-reviewed standalone district deployment, set private MCP_CONFIG with Wrangler's
secret provisioning, choose a district-specific Worker name/custom domain in a private deployment
override, and apply the generated Durable Object binding and SQLite migration. The committed
config contains no district data or live account routes. Validate without deploying:

```
pnpm --filter @educateos/external-mcp exec wrangler deploy --config deploy/wrangler.jsonc --dry-run --outdir /tmp/educateos-mcp-dry-run
```

No merge or deployment is part of this draft follow-up. This is a deployable resource-server
component with explicit integration handoffs, not a claim of a production-ready district installation.
