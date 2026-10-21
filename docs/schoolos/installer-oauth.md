# Installer OAuth: public client, scopes and fallback

- Status: Research, 2026-10-21. Every claim cites Cloudflare's public documentation or source as
  read that day. Nothing here has been tried against a live account.
- Issue: SCHO-67 (follow-up of SCHO-29). Code: `packages/schoolos-installer/src/oauth.ts`.
- Related: [installer-permissions.md](installer-permissions.md), whose two "OAuth gaps" this page
  answers.

## Summary

| Question | Answer | Confidence |
| --- | --- | --- |
| Can a third party register its own OAuth client with Cloudflare? | **Yes.** Self-managed OAuth clients shipped on 2026-06-03. | High (documented) |
| Can customers outside our account authorize it? | Yes, if the client is made **public**, which needs a verified domain. | High (documented) |
| PKCE with no client secret? | Yes. Authorization Code with PKCE (`S256`), token auth method `none`. | High (documented) |
| Dynamic client registration on the account OAuth server? | No. Clients are registered in the dashboard or through the API. | High (discovery document) |
| A scope for Access applications and policies? | Scope names exist (`access-app.write`, `access-policy.write` and others). Whether a self-registered public client may request them is **not documented**. | Medium |
| A scope for AI Gateway? | Scope names exist (`aig.write`, `aig:write`). Same caveat. | Medium |
| Revocation endpoint? | Yes, `https://dash.cloudflare.com/oauth2/revoke`. | High (documented) |
| Refresh tokens and token lifetime for third-party clients? | Not documented. | n/a |

So SCHO-29's first gap, whether a public client can be registered at all, is closed. The second gap
has shrunk. The scope names exist; what's left is confirming that our public client may request
them.

## What is supported

### Self-managed OAuth clients

Cloudflare's changelog entry of 2026-06-03 announced "self-managed OAuth clients", enabling
"developers to build third-party applications that integrate with Cloudflare via OAuth":
<https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/>.

The reference is <https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/>
(updated 2026-08-20):

- **Who can create one.** Account members with Super Administrator, Administrator or OAuth Client
  Write.
- **Where.** In the dashboard, under Manage Account, then OAuth clients. Or through the API:
  - `POST /client/v4/accounts/{account_id}/oauth_clients`, with a token holding `OAuth Clients Write`;
  - `PATCH .../oauth_clients/{client_id}` to change one;
  - `POST|DELETE .../oauth_clients/{client_id}/rotate_secret`, which matters only to confidential
    clients.
- **Visibility.** "New OAuth clients default to private visibility. Private clients can only be
  authorized by members of the parent Cloudflare account. Public clients allow authorization from any
  Cloudflare user." To make a client public:
  - it needs a name, a logo, a client URL and its scopes;
  - its domain must be verified with a DNS TXT record whose value has the prefix
    `cloudflare_oauth_client_publisher=`;
  - and "Setting a client's visibility to public is permanent."
- **Grant types.** The supported flows include "Browser-based, mobile, desktop, or CLI app |
  Authorization Code with PKCE | `none` | Required, `S256`", and "Clients that use PKCE do not need a
  client secret." Also: "Cloudflare does not support Client Credentials, Implicit, Resource Owner
  Password Credentials, Device Authorization, or other OAuth grant types for third-party clients."
- **Scope names.** "OAuth scope names correspond to Cloudflare API token permission names." The
  authoritative list is `GET https://api.cloudflare.com/client/v4/oauth/scopes`. That endpoint
  needs authentication: it answered 401 without a token on 2026-10-21.

The OAuth overview says the feature is available on every plan:
<https://developers.cloudflare.com/fundamentals/oauth/>.

### The consent screen and revocation

From <https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/>:

- The consent screen shows the publisher's verification and lets the user choose which accounts to
  grant.
- Users revoke a grant under their profile's Access Management, then Authorization:
  <https://dash.cloudflare.com/?to=/profile/access-management/authorization>.
- An account administrator can block new grants under Manage Account, then Members, then Settings,
  then "Public OAuth App access". Existing grants are not removed. A district that has turned this
  off has to turn it back on for the install, or use the district-run path.

Users can also deselect optional scopes, and the token then carries only what they agreed to
(<https://blog.cloudflare.com/task-based-oauth-consent/>). **This matters to the installer:**
`OAuthTokens.scopes` must be compared with what the reconciler needs before an install starts, and a
missing scope reported by preflight as `permission.missing`.

### Endpoints

From <https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/> and the
discovery document <https://dash.cloudflare.com/.well-known/openid-configuration>:

- `https://dash.cloudflare.com/oauth2/auth`
- `https://dash.cloudflare.com/oauth2/token`
- `https://dash.cloudflare.com/oauth2/revoke`
- `/.well-known/jwks.json` and `/.well-known/openid-configuration`

These match `CLOUDFLARE_OAUTH_ENDPOINTS` in `oauth.ts`. The discovery document has no
`registration_endpoint`.

Wrangler's own flow is a working PKCE `S256` public client:

- the authorization URL: <https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/generate-auth-url.ts>
- refresh with `client_id` only: `packages/workers-auth/src/token-exchange.ts`
- revoke with `token_type_hint=refresh_token`: `packages/workers-auth/src/flow.ts`

The installer's helpers follow the same shape.

### Scope names that exist

Wrangler's default login scopes,
<https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/core/scopes.ts>, include
`account:read`, `user:read`, `zone:read`, `workers:write`, `workers_kv:write`,
`workers_routes:write`, `workers_scripts:write`, `d1:write`, `ai:write` and `offline_access`. They
include **no** Access or AI Gateway scope. Note that `ai:write` is described as "See and change
Workers AI catalog and assets". **It is not AI Gateway.**

The `cf` CLI's registered list, `CF_CLIENT_REGISTERED_SCOPES` in
<https://github.com/cloudflare/workers-sdk/blob/main/packages/workers-auth/src/cf/scopes.ts>, has
about 470 scopes. Among them:

- **Access, legacy names:** `access:read`, `access:write`, `teams:read`, `teams:write`.
- **Access, per resource:**
  - `access-app.read|write|revoke` for applications
  - `access-policy.read|write`
  - `access-idp.read|write` for identity providers
  - `access-org.read|write|revoke`
  - `access-group.read|write`
  - `access-service-token.read|write`
- **AI Gateway:** `aig:read`, `aig:write`, `aig.read`, `aig.write`, `aig.run`.
- **Also:** `workers-r2.write`, `workers-kv-storage.write`, `d1.write`, `workers-scripts.write`,
  `account_api_tokens:create`.
- **Registered but not grantable,** per a comment in that file: `billing:read`, `billing:write` and
  four more. **This matters to the installer:** `listSubscriptions` can't rely on a billing scope.
  Whether `account:read` covers it becomes a probe for the sandbox run.

Cloudflare's own Code Mode MCP server, which uses the same consent service, advertises
`access-app.write`, `access-policy.write`, `access-idp.write`, `aig.write`, `aig.run`, `d1.write`,
`workers-kv-storage.write`, `workers-r2.write` and `workers-scripts.write` in
`https://mcp.cloudflare.com/.well-known/oauth-authorization-server`. That shows these scopes can be
granted through Cloudflare's consent flow. It does not show that a third-party client may request
them.

## What is not supported, or not documented

- **Dynamic client registration** on `dash.cloudflare.com`. There is none, so every SchoolOS
  environment's client (production and staging) is registered by hand or through the API.
- **The device flow and client credentials** for third parties. These are explicitly unsupported.
  The installer's browser flow is the only path.
- **Not documented:**
  - the full `/oauth/scopes` catalog, and whether a public client may select every scope in it;
  - refresh-token and `offline_access` rules for third-party clients, and token lifetimes;
  - any app review, limit on the number of clients, or partner tier;
  - whether "Public OAuth App access" is on by default for an Enterprise account.
- **The Deploy to Cloudflare button** (<https://developers.cloudflare.com/workers/platform/deploy-buttons/>).
  It deploys a public repository through Cloudflare's own flow, with no credential reaching the third
  party. Its page lists no Access application or AI Gateway among the resources it sets up. So it is
  not an install path for SchoolOS, which needs both and needs signed releases.

## Fallback

If our public client can't get the Access scopes, the plan from installer-permissions.md stands,
and the reconciler already supports it:

1. The district runs the installer once in district-run mode, with an API token holding Access:
   Apps and Policies: Edit, and Access: Organizations, Identity Providers, and Groups: Read. That run
   creates the Access application and policy.
2. Every later OAuth run sees Access as `noop`.

If AI Gateway's scope is missing, the gateway is optional: preflight warns, and the district creates
it by hand or in the same district-run step.

An **account-owned API token** (<https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/>)
is the better district-run credential. It keeps working after the person who created it leaves,
Cloudflare's compatibility matrix lists Access, AI Gateway, D1, R2, Workers and KV as supported, and
the district deletes it when it's done.

## Exact questions for Cloudflare

Send these to Cloudflare. Developer relations or the account team are the likely route. Name the
client ID once it is registered.

1. Can a **public** self-managed OAuth client request the per-resource Access scopes
   `access-app.write`, `access-policy.write`, `access-org.read` and `access-idp.read`? If not, which
   Access scopes, if any, can it request?
2. Can it request `aig.write` (or `aig:write`) for AI Gateway?
3. Which scope covers `GET /accounts/{account_id}/subscriptions`, given that `billing:read` is
   registered but not grantable? Does `account:read` cover it?
4. Which scope covers R2 bucket creation: `workers:write`, `workers-r2.write`, or both?
5. Does a third-party client receive a refresh token for `offline_access`? What are the access- and
   refresh-token lifetimes?
6. Does revoking at `/oauth2/revoke` with the refresh token also invalidate access tokens already
   issued from it, and how quickly?
7. When a user deselects an optional scope, is the token response's `scope` field guaranteed to list
   only the granted scopes?
8. Is "Public OAuth App access" on by default for Enterprise accounts? Can a district allow one client
   without allowing all?
9. Is there a review or verification step beyond the DNS TXT record before a client becomes public?
   Is there a limit on the number of clients per account?
10. Is there a plan for a scope that is limited to resources created by the client? That would let
    the installer's grant exclude a district's existing Workers, KV and D1 data (ADR-0001).

## What remains to wire up (the rest of SCHO-67)

Once questions 1, 2 and 5 are answered:

1. **Register the client.** Register the root's public client in the SchoolOS root account, and verify
   the `schoolos.dev` domain with the TXT record.
2. **Correct `INSTALLER_SCOPES`.** It is in `src/oauth.ts`, and is a code change for a separate PR:
   - Replace `ai:write`, which is Workers AI, with the AI Gateway scope Cloudflare confirms.
   - Replace the guessed `access:write` with the confirmed Access scopes.
   - Mark each one `documented` instead of `unverified`.
3. **Check the granted scopes in preflight.** Compare `OAuthTokens.scopes` with the reconciler's needs,
   and report `permission.missing` for any the user deselected.
4. **Wire the setup flow.** Put `createPkcePair`, `buildAuthorizationUrl`, `exchangeAuthorizationCode`,
   `OAuthTokenProvider` and `install()` into the `schoolos.dev` setup flow, and revoke the grant at
   `/oauth2/revoke` once the install completes.
5. **Re-run the sandbox harness.** Run SCHO-66's harness (`scripts/verify-account.ts`) with an OAuth
   access token instead of an API token, and record per-scope results in installer-permissions.md.
