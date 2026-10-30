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
is display metadata, never authorization. MCP cannot approve or decline anything: a person
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
