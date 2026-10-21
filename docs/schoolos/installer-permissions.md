# Installer permissions and blocking Cloudflare requirements

- Status: Draft. Nothing here has been checked against a live Cloudflare account yet.
- Issue: SCHO-29 (roadmap R02)
- Code: `packages/schoolos-installer`

The roadmap asks R02 to "record actual blocking Cloudflare permission requirements". This page
lists what the installer calls, which permission each call needs in each install mode, and what an
account must have before an install can start. **Unverified** marks every claim that has not been
confirmed against a live account. Treat those as hypotheses to test in the G2 sandbox account,
not as facts.

## Install modes

| Mode | Credential | Who holds it | How it ends |
| --- | --- | --- | --- |
| OAuth | Access token from the root's public OAuth client (PKCE, no client secret) | `schoolos.dev`, for the length of the install | The district owner revokes the grant in the Cloudflare dashboard. |
| District-run | API token the district creates | The district's CLI or CI (`CLOUDFLARE_API_TOKEN`) | The district deletes the token. |

Both modes run the same reconciler. Its state is what it observes in the account, with no local
state file, so either mode can pick up where the other stopped.

## Per-operation permissions

"API token permission" is the permission group a district-run token needs. Names follow the
Cloudflare dashboard's token editor and are **unverified** until a sandbox install succeeds with
exactly this set. "OAuth scope" is the scope the public client requests.
`wrangler-requested` means Wrangler's own `wrangler login` requests that scope name, so the name
exists, but which operations it covers is inferred. `unverified` means the scope name itself is a
guess.

| Installer operation | Endpoint (`/client/v4`) | API token permission | OAuth scope | Scope evidence |
| --- | --- | --- | --- | --- |
| `getAccount` | `GET /accounts/{id}` | Account Settings: Read | `account:read` | wrangler-requested |
| `listSubscriptions` (plan check) | `GET /accounts/{id}/subscriptions` | Billing: Read | `account:read` | unverified (may need a billing scope) |
| `findZone` | `GET /zones?name=` | Zone: Read | `zone:read` | wrangler-requested |
| `listDnsRecords` | `GET /zones/{zone}/dns_records` | DNS: Read | `zone:read` | unverified (may need a DNS scope) |
| `listWorkerScripts`, `getWorkerSettings`, `uploadWorkerScript` | `/accounts/{id}/workers/scripts[/{name}[/settings]]` | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `deleteWorkerScript` (disabling a service) | `DELETE /accounts/{id}/workers/scripts/{name}` (never `force`) | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `createAssetsUploadSession`, `uploadAssets` | `.../assets-upload-session`, `/workers/assets/upload` (session JWT) | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `listWorkerSecrets`, `putWorkerSecret` | `.../scripts/{name}/secrets` | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `listWorkerVersions`, `deployWorkerVersion` (rollback) | `.../versions`, `.../deployments` | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `listWorkerDomains`, `attachWorkerDomain` | `/accounts/{id}/workers/domains` | Workers Scripts: Edit, plus Workers Routes: Edit on the zone | `workers_routes:write` | wrangler-requested |
| `listKvNamespaces`, `createKvNamespace` | `/accounts/{id}/storage/kv/namespaces` | Workers KV Storage: Edit | `workers_kv:write` | wrangler-requested |
| `listR2Buckets`, `createR2Bucket` | `/accounts/{id}/r2/buckets` | Workers R2 Storage: Edit | `workers:write` | unverified (R2 coverage inferred) |
| `listD1Databases`, `createD1Database`, `queryD1` | `/accounts/{id}/d1/database[/{uuid}/query]` | D1: Edit | `d1:write` | wrangler-requested |
| `getAccessOrganization`, `listAccessIdentityProviders` | `/accounts/{id}/access/organizations`, `.../identity_providers` | Access: Organizations, Identity Providers, and Groups: Read | `access:write` | unverified |
| Access policies and applications | `/accounts/{id}/access/policies`, `/accounts/{id}/access/apps` | Access: Apps and Policies: Edit | `access:write` | unverified |
| `listAiGateways`, `createAiGateway` (optional) | `/accounts/{id}/ai-gateway/gateways` | AI Gateway: Edit | `ai:write` | unverified |
| (refresh tokens) | `https://dash.cloudflare.com/oauth2/token` | n/a | `offline_access` | wrangler-requested |

Two OAuth gaps may block OAuth mode outright, pending Cloudflare's answer:

1. **Public client registration.** Wrangler's client ID belongs to Cloudflare. Whether a third
   party can register a public OAuth client for these scopes is unknown. Until it can, OAuth mode
   cannot ship, and district-run is the only mode.
2. **Access and AI Gateway scopes.** Wrangler requests no Access scope. If no OAuth scope covers
   Access, an OAuth install cannot create the Access application. The fallback is a district-run
   step for Access only. The reconciler already supports that: run district-run once, and OAuth
   runs then see Access as `noop`.

## Account requirements preflight blocks on

| Code | Requirement | Operator action |
| --- | --- | --- |
| `plan.workers-paid-required` | Workers Paid (rate plan `workers_paid`; other qualifying plan IDs are **unverified**) | Subscribe to Workers Paid. |
| `product.r2-not-enabled` | R2 enabled (Cloudflare error code 10042 when it isn't, **unverified**) | Enable R2; it needs a payment method. |
| `access.organization-missing` | A Zero Trust organization | Create the team named in the install config. |
| `access.team-mismatch` | The configured team is the account's | Fix `access.teamName`. |
| `access.idp-missing` | A district IdP besides one-time PIN | Add the district's SAML or OIDC provider. |
| `dns.zone-missing`, `dns.zone-pending` | The base domain is an active zone in the account | Add the zone and delegate its nameservers. |
| `dns.record-conflict` | The SchoolOS hostname has no existing DNS records | Remove them or pick another subdomain. |
| `quota.*` | Room under documented per-account limits (Workers 500, KV 1,000, D1 50,000, R2 1,000,000; **unverified** per account) | Free up resources or request a raise. |
| `service.input-missing` | Every `var` input of an enabled service is in the config | Set `services["<pkg>"].vars.<NAME>`. |
| `service.secret-missing` | Every secret input of an enabled service is supplied, or already set on its Worker | Supply it through the secret source (`SCHOOLOS_SECRET_<PKG>__<NAME>` for the CLI). |
| `permission.missing`, `credential.rejected` | The credential works and has each permission above | Re-authorize, or grant the named permission. |

Preflight also warns (`access.free-seat-limit`) when it finds no paid Zero Trust plan. Zero Trust
Free admits 50 users, and every student and teacher who signs in takes a seat. It warns
(`product.worker-loader`) that Worker Loader availability can't be checked through the API, and
(`service.var-size`) when a service var is over the documented 5 KB variable limit.

## Optional services

A release worker of kind `service` (today only `schoolos-ai-guard`) is installed only when the
config names it under `services` with `enabled: true`, its `var` inputs under `vars` and its
secrets from the secret source. The backend then gains the manifest's `backendBinding` (for the
guard, `AI_CALL_GUARD` to the `SchoolOsAiCallGuard` entrypoint), and the backend is uploaded only
after the service Worker and its secrets exist. `enabled: false` reverses this: the backend is
re-uploaded without the binding, then the service Worker is deleted, which also deletes its
Durable Object data (the guard's spend ledger). A service the config does not name is neither
installed nor removed. The installer deletes only Workers carrying its own instance marker.

Drift detection compares each Worker's deployed service bindings with the desired ones directly,
because a dashboard edit keeps the installer's digest marker; a removed or retargeted
`AI_CALL_GUARD` is reported and repaired by the next apply. Rollback refuses to redeploy a version
whose service binding targets a Worker that no longer exists, and notes when it returns the
backend to a version without a binding.

## What the credential can reach, and what the installer touches

Cloudflare's permission groups are coarser than the installer's needs. Workers KV Storage: Edit
can read KV values. Workers R2 Storage: Edit can read objects. D1: Edit can query any table. So
ADR-0001's rule that the installer never holds data access rests on three things, not on scopes:

- The `CloudflareApi` port has no KV value, R2 object or Worker tail operation. `queryD1` runs only
  the release's migration SQL and reads only the `_schoolos_migrations` ledger, which holds
  migration IDs.
- OAuth grants are for the install session. The district revokes them when it is done, and a
  revoked grant stops the installer at its next call (tested). The deployed district keeps serving.
- The district agent's private key and the root's ownership token go straight into backend Worker
  secrets, which cannot be read back. The installer never stores them.

## Behaviour on credential failure

Any 401 or 403, any of Cloudflare codes 1000, 6003, 6111, 9106, 9109 or 10001 (the code list is
**unverified**), or a token provider that can no longer produce a token (refused OAuth refresh,
unset environment variable) stops the run with `InstallerHaltedError` at that call. No retry
follows and no other operation runs. Resources already created stay as they are. A later run with
a working credential, in either mode, continues from them.

## Not yet verified, to check in the G2 sandbox

- Every permission name and scope marked unverified above.
- Whether a multi-statement D1 `/query` request carrying `params` runs as one batch. The installer
  depends on this to apply a migration and its ledger row together.
- The `environment` field on `PUT /workers/domains`.
- Whether version detail responses expose plain-text binding values. Rollback finds the previous
  release's version through them, and reads service binding targets from the same response.
- That deleting a Worker another Worker's deployed version binds is refused without `force` (the
  fake models it; the error codes are not known).
