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

POST `/mcp` serves two protocol revisions through the pinned official SDK
(`@modelcontextprotocol/server` **2.4.0**, `createMcpHandler`):

- **2026-07-28 (modern), stateless.** It supports `server/discover`. The required
  `Mcp-Method`/`Mcp-Name` headers are checked against the body, and a mismatch is a 400. Each
  request carries the `_meta` envelope, and there is no `initialize` and no session. Responses
  are JSON.
- **2025-11-25 (legacy), stateless.** It supports initialize, notifications/initialized, ping,
  tools/list and tools/call. Responses are JSON (`enableJsonResponse`), with no session ID.

The server pins exactly these two revisions with `supportedProtocolVersions`. GET/SSE and DELETE
answer 405. Bodies are bounded to 64 KiB (413). Requests with an unapproved Origin are refused,
and only exact allowed origins get CORS headers.

Authorization happens per request, before the SDK reads the body, and covers listings too.
`tools/list` carries `ttlMs: 0` and `cacheScope: private`, so a listing a client obtained earlier
never stands in for a token, link or delegation that has since been revoked. The tests drive the
API with the official client (`@modelcontextprotocol/client` 2.4.0) in both modes, on Node and on
workerd.

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

Authorization code/PKCE and authorization-server discovery belong to the district's
authorization server (Nathan, NATH-6), never to this package. Public routing on the district
origin is a separate SCHO-174 change.

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
It serves the same wire profile as the library: 2026-07-28 and 2025-11-25 (see above). The sections above describe the parent library; the Worker adds discovery and CORS.

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

## Protected resource for the district's authorization server (SCHO-174)

`@educateos/external-mcp/resource-auth` exports `DelegatedResourceAuthority`, which lets the
district `/mcp` act as an OAuth protected resource for the district's configured authorization
server. That server is Nathan (NATH-6); EducateOS builds no authorization server. The authority
trusts exactly one issuer, whose JWKS URL comes from deployment configuration. On **every**
request it checks:

- the JWS signature, using a configured key with an allowed asymmetric algorithm (the `jku`,
  `x5u` and `kid` URLs a token names are never fetched);
- `typ: at+jwt` (RFC 9068);
- `iss` exactly;
- `aud`, which must be exactly the district's `https://<origin>/mcp` and its only audience (RFC 8707);
- `exp`, `nbf` and `iat`, with a lifetime of at most ten minutes, allowing 30 seconds of clock skew with the issuer;
- the required `scope` (`mcp:tools`).

After the token checks it resolves `(iss, sub)` through the district's current identity links.
Token claims never name a role, principal, district or delegation.

**Client and delegation.** The token's `client_id` (RFC 9068), which is a Client ID Metadata
Document URL or an assigned ID, names the client. The authority then looks for the one IF-06
delegation in force whose grantor is the resolved principal and whose client is
`(iss, client_id)`. It sets that delegation as `subject.delegationId`, so the policy engine bounds
every call by the delegation's ceiling and the grantor's live roster standing. The two refusals
are distinct errors:

- `unauthenticated` (401): a token, link or principal that is not accepted;
- `forbidden` (403): no delegation in force, or more than one, from that person to that client.

Revoking the delegation, deactivating the principal or unlinking the identity refuses the next
request, even while the token is unexpired. A cached tool listing carries no authority, and each
request is authenticated again.

The district Worker composes this authority with `createSchoolMcpApi` and `externalSchoolTools`
over its own delegation store, behind `DISTRICT_CONFIG.mcp`, which is off by default (see that
package's README).

What NATH-6 must issue for a district resource:

- a JWT with `typ: at+jwt`, signed with an asymmetric key published at the configured JWKS URL;
- `iss`: the district's Nathan issuer, which the district lists in `trustedIssuers`;
- `aud`: exactly `https://<district>/mcp`, the RFC 8707 `resource` the client requested;
- `sub`: the Nathan user ID, linked to the teacher's principal;
- `client_id`;
- `scope`, including `mcp:tools`;
- `iat` and `exp`, ten minutes apart at most.
