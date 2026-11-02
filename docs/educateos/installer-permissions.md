# Installer permissions and blocking Cloudflare requirements

- Status: Draft. The district-run token with exactly the API token permissions below completed a full install into a live account on 2026-10-26 (SCHO-206, docs/educateos/control-plane.md); the OAuth column and the per-permission minimum are still unverified. The 2026-10-31 sandbox run (SCHO-66, [below](#sandbox-run-2026-10-31-scho-66)) settled the Workers, zone and Access rows and three API assumptions; the 2026-11-02 run ([below](#sandbox-run-2026-11-02-scho-66)) settled Billing, KV, D1 and AI Gateway and found that D1 refuses `params` on a multi-statement request.
- Issue: SCHO-29 (roadmap R02)
- Code: `packages/educateos-installer`

The roadmap asks R02 to "record actual blocking Cloudflare permission requirements". This page
lists what the installer calls, which permission each call needs in each install mode, and what an
account must have before an install can start. **Unverified** marks every claim that has not been
confirmed against a live account. Treat those as hypotheses to test in the G2 sandbox account,
not as facts.

## Install modes

| Mode | Credential | Who holds it | How it ends |
| --- | --- | --- | --- |
| OAuth | Access token from the root's public OAuth client (PKCE, no client secret) | `educateos.io`, for the length of the install | The district owner revokes the grant in the Cloudflare dashboard. |
| District-run | API token the district creates | The district's CLI or CI (`CLOUDFLARE_API_TOKEN`) | The district deletes the token. |

Both modes run the same reconciler. Its state is what it observes in the account, with no local
state file, so either mode can pick up where the other stopped.

District-run mode needs nothing from `educateos.io`: the district builds or downloads a release,
verifies it offline against the keys it pins ([release-signing.md](release-signing.md)), and
installs it with its own token. OAuth mode exists for the optional guided bootstrap
(ADR-0011), and the root holds its token only for the length of the install. Registering the
instance with a registry is a separate, optional step: it runs only when the install config has a
`fleet` section and the CLI is given `--registry-url`, and it is off by default.

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
| `listSubscriptions` (plan check) | `GET /accounts/{id}/subscriptions` | Billing: Read (verified 2026-11-02, SCHO-66; without it HTTP 403, code 10000) | `account:read` | unverified (may need a billing scope) |
| `findZone` | `GET /zones?name=` | Zone: Read (verified 2026-10-31, SCHO-66) | `zone:read` | wrangler-requested |
| `listDnsRecords` | `GET /zones/{zone}/dns_records` | DNS: Read (verified 2026-10-31, SCHO-66, with DNS: Edit) | `zone:read` | unverified (may need a DNS scope) |
| `listWorkerScripts`, `getWorkerSettings`, `uploadWorkerScript` | `/accounts/{id}/workers/scripts[/{name}[/settings]]` | Workers Scripts: Edit (verified 2026-10-31, SCHO-66) | `workers_scripts:write` | wrangler-requested |
| `deleteWorkerScript` (disabling a service) | `DELETE /accounts/{id}/workers/scripts/{name}` (never `force`) | Workers Scripts: Edit (verified 2026-10-31, SCHO-66) | `workers_scripts:write` | wrangler-requested |
| `createAssetsUploadSession`, `uploadAssets` | `.../assets-upload-session`, `/workers/assets/upload` (session JWT) | Workers Scripts: Edit | `workers_scripts:write` | wrangler-requested |
| `deleteWorkerSecret` (adopting a Worker deployed outside the installer, SCHO-243) | `DELETE /accounts/{id}/workers/scripts/{name}/secrets/{secret}` | Workers Scripts: Edit (**unverified**: never yet called against a live account) | `workers_scripts:write` | wrangler-requested |
| `listWorkerSecrets`, `putWorkerSecret` | `.../scripts/{name}/secrets` | Workers Scripts: Edit (verified 2026-10-31, SCHO-66) | `workers_scripts:write` | wrangler-requested |
| `getWorkerSchedules`, `putWorkerSchedules` (Cron Triggers, SCHO-148) | `GET`/`PUT /accounts/{id}/workers/scripts/{name}/schedules` | Workers Scripts: Edit (`GET` verified 2026-11-02 on the owner account, SCHO-243's prairie plan; `PUT` refused with HTTP 403, code 10063, on the sandbox account, which has no Workers Paid plan) | `workers_scripts:write` | wrangler-requested (Wrangler sets crons with it) |
| `listWorkerVersions`, `deployWorkerVersion` (rollback) | `.../versions`, `.../deployments` | Workers Scripts: Edit (`listWorkerVersions` verified 2026-10-31, SCHO-66) | `workers_scripts:write` | wrangler-requested |
| `listWorkerDomains`, `attachWorkerDomain` | `/accounts/{id}/workers/domains` | Workers Scripts: Edit, plus Workers Routes: Edit on the zone (verified 2026-10-31, SCHO-66) | `workers_routes:write` | wrangler-requested |
| `detachWorkerDomain` (releasing a managed hostname) | `DELETE /accounts/{id}/workers/domains/{domain}` | Workers Scripts: Edit, plus Workers Routes: Edit on the zone (verified 2026-10-31, SCHO-66; it answers HTTP 200 with an empty body) | `workers_routes:write` | unverified |
| `getFallbackOrigin`, `setFallbackOrigin`, `findCustomHostname`, `createCustomHostname`, `deleteCustomHostname` (the managed hostname, cross-account) | `/zones/{zone}/custom_hostnames[/fallback_origin]` | SSL and Certificates: Edit | `ssl_certs:write` | wrangler-requested |
| `listWorkerRoutes`, `createWorkerRoute`, `deleteWorkerRoute` (the managed hostname, cross-account) | `/zones/{zone}/workers/routes` | Workers Routes: Edit | `workers_routes:write` | wrangler-requested |
| `createDnsRecord` (the managed hostname's originless fallback origin, `educateos-origin.<zone>`, only on a zone with no fallback origin) | `POST /zones/{zone}/dns_records` | DNS: Edit | none known: Wrangler requests no DNS write scope, so an OAuth install on such a zone fails here until one is verified | unverified |
| `listKvNamespaces`, `createKvNamespace` | `/accounts/{id}/storage/kv/namespaces` | Workers KV Storage: Edit (verified 2026-11-02, SCHO-66: list, create and delete; without it HTTP 401, code 10000) | `workers_kv:write` | wrangler-requested |
| `listR2Buckets`, `createR2Bucket` | `/accounts/{id}/r2/buckets` | Workers R2 Storage: Edit (verified 2026-11-02 on the owner account; without it HTTP 403, code 10000; on an account without R2 enabled, HTTP 403, code 10042, whatever the token) | `workers:write` | unverified (R2 coverage inferred) |
| `listD1Databases`, `createD1Database`, `queryD1` | `/accounts/{id}/d1/database[/{uuid}/query]` | D1: Edit (verified 2026-11-02, SCHO-66: create, query and delete; without it HTTP 401, code 10000) | `d1:write` | wrangler-requested |
| `getAccessOrganization`, `listAccessIdentityProviders` | `/accounts/{id}/access/organizations`, `.../identity_providers` | Access: Organizations, Identity Providers, and Groups: Read (calls verified 2026-10-31, SCHO-66; the token's exact Access groups could not be read back) | `access:write` | unverified |
| Access policies and applications | `/accounts/{id}/access/policies`, `/accounts/{id}/access/apps` | Access: Apps and Policies: Edit (verified 2026-10-31, SCHO-66: list, create and delete) | `access:write` | unverified |
| `listAiGateways`, `createAiGateway` (optional) | `/accounts/{id}/ai-gateway/gateways` | AI Gateway: Edit (verified 2026-11-02, SCHO-66: list, create and delete; without it HTTP 403, code 10000) | `ai:write` | unverified |
| (refresh tokens) | `https://dash.cloudflare.com/oauth2/token` | n/a | `offline_access` | wrangler-requested |

The OSS admin (`admin.enabled`, SCHO-263) needs no permission beyond these: its Worker, secret and
custom domain use the Workers Scripts rows, its database and migrations the D1 row, and its two
Access applications the Access row. Its hostname must be in the base domain's zone, the one zone the
token already covers.

Two OAuth gaps may block OAuth mode outright, pending Cloudflare's answer. [installer-oauth.md](installer-oauth.md)
(SCHO-67, 2026-10-21) has since found that third parties can register public OAuth clients, and
that Access and AI Gateway scope names exist; whether a public client may request them is still
open. [runbooks/installer-sandbox-verification.md](runbooks/installer-sandbox-verification.md)
(SCHO-66) is the procedure that settles the **unverified** rows below.

1. **Public client registration.** Wrangler's client ID belongs to Cloudflare. Whether a third
   party can register a public OAuth client for these scopes is unknown. Until it can, OAuth mode
   cannot ship, and district-run is the only mode.
2. **Access and AI Gateway scopes.** Wrangler requests no Access scope. If no OAuth scope covers
   Access, an OAuth install cannot create the Access application. The fallback is a district-run
   step for Access only. The reconciler already supports that: run district-run once, and OAuth
   runs then see Access as `noop`.

The managed zone's half of a managed hostname (`planManagedZone`, `applyManagedZone`) runs with
educateos.io's own token, never a district's: DNS: Edit on the educateos.io zone (`listDnsRecords`,
`createDnsRecord`, `updateDnsRecord`, `deleteDnsRecord`). That token is the Keychain item
`educateos-cf-subdomains-token` ("EducateOS subdomains (educateos.io)": Zone Read, DNS Edit, SSL and
Certificates Edit and Workers Routes Edit on educateos.io, and Workers Scripts Edit on the account).

The cross-account rows' API-token permissions were exercised live on 2026-10-26 (SCHO-241), with a
district-run token in a second account holding, among others, DNS: Edit, SSL and Certificates: Edit, Workers
Routes: Edit, Zone: Edit, Workers Scripts: Edit and Access: Apps and Policies: Edit. That settles
the token column for a district-run install only; the OAuth column is unchanged, and an OAuth
install still has no known scope for the origin record.

## Account requirements preflight blocks on

| Code | Requirement | Operator action |
| --- | --- | --- |
| `plan.workers-paid-required` | Workers Paid (rate plan `workers_paid`; other qualifying plan IDs are **unverified**) | Subscribe to Workers Paid. |
| `product.r2-not-enabled` | R2 enabled (Cloudflare error code 10042 when it isn't, **unverified**) | Enable R2; it needs a payment method. |
| `access.organization-missing` | A Zero Trust organization | Create the team named in the install config. |
| `access.team-mismatch` | The configured team is the account's | Fix `access.teamName`. |
| `access.idp-missing` | A district IdP besides one-time PIN | Add the district's SAML or OIDC provider. |
| `dns.zone-missing`, `dns.zone-pending` | The base domain is an active zone in the account | Add the zone and delegate its nameservers. |
| `dns.record-conflict` | The EducateOS hostname, and the OSS admin's when `admin.enabled`, has no existing DNS records | Remove them, or pick another subdomain or `admin.hostname`. |
| `dns.managed-only-cross-account` | A managed-only install (no `baseDomain`, SCHO-243) needs educateos.io as an active zone in the account. It replaces `dns.zone-*` and `dns.record-conflict`, which only apply to a base domain | Set `baseDomain` to a zone of the district's own, or install into the account that holds educateos.io. |
| `quota.*` | Room under documented per-account limits (Workers 500, KV 1,000, D1 50,000, R2 1,000,000; **unverified** per account) | Free up resources or request a raise. |
| `service.input-missing` | Every `var` input of an enabled service is in the config | Set `services["<pkg>"].vars.<NAME>`. |
| `service.secret-missing` | Every secret input of an enabled service is supplied, or already set on its Worker | Supply it through the secret source (`EDUCATEOS_SECRET_<PKG>__<NAME>` for the CLI). |
| `permission.missing`, `credential.rejected` | The credential works and has each permission above | Re-authorize, or grant the named permission. |

Preflight also warns (`access.free-seat-limit`) when it finds no paid Zero Trust plan. Zero Trust
Free admits 50 users, and every student and teacher who signs in takes a seat. It warns
(`product.worker-loader`) that Worker Loader availability can't be checked through the API, and
(`service.var-size`) when a service var is over the documented 5 KB variable limit.

## Managed-only installs

With `managedHostname` set and no `baseDomain` (SCHO-243), `<slug>.educateos.io` is the install's
public hostname and identity: the Access applications, the school manifest's `origin` and
`$PUBLIC_BASE_URL` all use it, and the router gets it as a Workers custom domain on educateos.io
(the managed hostname's same-account path) instead of a custom domain on a district zone. This
works only where educateos.io is a zone in the district's account, which means the owner's hosted
districts. A district in another account would need the Cloudflare for SaaS path, which puts the
custom hostname on the district's own zone, and a managed-only district has none, so preflight
blocks it (`dns.managed-only-cross-account`) and the plan refuses it. The OSS admin needs a
hostname in a zone of the district's own, so `admin.enabled` is refused on a managed-only install
for now. The token needs Zone: Read on educateos.io, DNS: Read on it (the slug check) and Workers
Routes: Edit on it (the custom domain), besides the Workers Scripts rows.

## Optional services

A release worker of kind `service` (today only `educateos-ai-guard`) is installed only when the
config names it under `services` with `enabled: true`, its `var` inputs under `vars` and its
secrets from the secret source. The backend then gains the manifest's `backendBinding` (for the
guard, `AI_CALL_GUARD` to the `EducateOsAiCallGuard` entrypoint), and the backend is uploaded only
after the service Worker and its secrets exist. `enabled: false` reverses this: the backend is
re-uploaded without the binding, then the service Worker is deleted, which also deletes its
Durable Object data (the guard's spend ledger). A service the config does not name is neither
installed nor removed. The installer deletes only Workers carrying its own instance marker.

Drift detection compares each Worker's deployed service bindings with the desired ones directly,
because a dashboard edit keeps the installer's digest marker; a removed or retargeted
`AI_CALL_GUARD` is reported and repaired by the next apply. Rollback refuses to redeploy a version
whose service binding targets a Worker that no longer exists, and notes when it returns the
backend to a version without a binding.

## Cron Triggers

A Worker whose release entry declares `crons` (the AI call guard's nightly reconciliation, the
district Worker's notification and digest runs) gets them as its whole schedule list, with
`PUT .../schedules`, once the Worker and its secrets exist (SCHO-148, SCHO-243). Planning reads the
schedules back and compares them as a set of expressions written as the release writes them, so
a dashboard edit is reported as drift (`Cron Triggers differ: adds …; removes …`) and the next
apply restores the release's list. The installer leaves alone the schedules of a Worker whose
release entry declares none, so a release that drops a Worker's last cron leaves that schedule in
place until it is removed by hand.

Rollback redeploys Worker versions and does not touch schedules. A rollback to a release with
different crons leaves the newer release's schedules; the next forward apply sets them again.

**Unverified** until a live run: that a script upload leaves the schedules as they are (the fake
assumes so, as `wrangler deploy` re-sending them on each deploy suggests but doesn't prove), that
deleting a Worker deletes its schedules, the error code Cloudflare answers an unparseable
expression with (the fake answers HTTP 400 with no code), and the per-Worker and per-account
Cron Trigger limits. A plan never needs more than Workers Scripts: Edit for them.

## What the credential can reach, and what the installer touches

Cloudflare's permission groups are coarser than the installer's needs. Workers KV Storage: Edit
can read KV values. Workers R2 Storage: Edit can read objects. D1: Edit can query any table. So
ADR-0001's rule that the installer never holds data access rests on three things, not on scopes:

- The `CloudflareApi` port has no KV value, R2 object or Worker tail operation. `queryD1` runs only
  the release's migration SQL and reads only the `_educateos_migrations` ledger, which holds
  migration IDs.
- OAuth grants are for the install session. The district revokes them when it is done, and a
  revoked grant stops the installer at its next call (tested). The deployed district keeps serving.
- With optional instance registration only, the district agent's private key and the registry's
  ownership token go straight into backend Worker secrets, which cannot be read back. The installer
  never stores them. An install without registration creates neither.

## Adopting a Worker deployed outside the installer

A service's Worker is normally `<resourcePrefix>-<pkg>`. `services["<pkg>"].scriptName` names it
instead (SCHO-243), so the installer can adopt a Worker that must keep its name because its
Durable Objects hold data, such as a ForgeGraph-deployed demo district (`educateos-prairie-district`,
SCHO-231). The installer adopts a Worker without its instance marker only when the config names it
this way, and only when the Worker:

- carries no other instance's marker, and
- is at a Durable Object migration tag in the release's history. A release with migrations needs a
  tag: a Worker without one holds none of the package's objects.

The adoption is one upload of the release over the Worker. That adds the markers, continues its
migrations from the observed tag (none replayed when it is already at the last), and keeps its
secrets (`keep_bindings`). It first deletes any secret the release sets as a plain-text var instead.
A demo district keeps `DISTRICT_CONFIG`, `CF_ACCESS_ISS` and `CF_ACCESS_AUD` as secrets, and an
upload with a var of the same name is assumed to be refused. That is **unverified**; deleting first
works either way. Between those deletes and the upload, the Worker briefly runs without them.

A managed hostname attached to one of the install's own Workers, as the adopted district's is,
moves to the router with a detach and then an attach, after the Access applications cover it. The
hostname is unreachable between the two calls. A base-domain custom domain on such a Worker is not
moved; it reads as taken.

What adoption does not do:

- It does not adopt Access applications. A demo district's own application, and the shared health
  and LTI bypass applications, already protect its hostname, so the plan is blocked
  (`access:application ... already protects`) until the owner takes the hostname out of them. That
  is a step to plan around: the hostname must not serve without Access in between.
- It does not stop the old deployer. A ForgeGraph target that still deploys the Worker with Wrangler
  would overwrite the installer's upload and reattach the custom domain to it, so remove the target
  first.

## Behaviour on credential failure

Any 401 or 403, any of Cloudflare codes 1000, 6003, 6111, 9106, 9109 or 10001 (only 6003 is
verified: an invalid token gets HTTP 400 with code 6003; a missing permission gets HTTP 401 or 403
with code 10000, which the status alone already classifies; 2026-10-31, SCHO-66), or a token provider that can no longer produce a token (refused OAuth refresh,
unset environment variable) stops the run with `InstallerHaltedError` at that call. No retry
follows and no other operation runs. Resources already created stay as they are. A later run with
a working credential, in either mode, continues from them.

## Sandbox run, 2026-10-31 (SCHO-66)

Run with `scripts/verify-account.ts` on the second account (gmacko, `f84fe044…`, zone
`hbtply.com`), using the user-owned API token made for SCHO-241 (Keychain
`educateos-cf-byoa-gmacko-token`). That token cannot read its own permission groups
(`GET /user/tokens/{id}` answers 403, code 9109), so the results below are per call. Runs
`f3711681` (dry run), `4e1efdc0` and `6849c282` (apply); every probe resource was deleted.

Settled:

- **Workers, zone and Access calls**: every one listed above as verified 2026-10-31 succeeded.
  The account's only identity provider is one-time PIN, so a full install here would stop on
  `access.idp-missing`.
- **The `environment` field on `PUT /workers/domains`** is accepted: the attach succeeded with
  `environment: "production"`.
- **Version detail exposes plain-text binding values** (`plainTextVarsExposed: true`), and service
  binding targets with them, so rollback can find the previous release. Both parse with the
  installer's schemas (SCHO-163's items 2 and 3 no longer reproduce).
- **Deleting a Worker another Worker binds is refused without `force`**: HTTP 400, code 10142.
- **Deleting a Worker with a custom domain still attached is not refused**: it succeeds without
  `force`, and the domain goes with it.
- **`DELETE /workers/domains/{id}` answers HTTP 200 with an empty body.** The installer read that
  as a failure, so releasing a managed hostname failed after Cloudflare had done it; fixed in
  SCHO-66 (`emptyBodyIsSuccess`).
- **Credential codes**: an invalid token gets HTTP 400 with code 6003, which the installer treats as
  a credential failure. A missing permission gets code 10000 with HTTP 401 (KV, D1) or 403
  (Billing, R2, AI Gateway).

## Sandbox run, 2026-11-02 (SCHO-66)

Run `d0da8dd1` (apply) of `scripts/verify-account.ts` on the same account (gmacko, zone
`hbtply.com`), after Billing: Read, Workers KV Storage: Edit, Workers R2 Storage: Edit, D1: Edit and
AI Gateway: Edit were added to the same token. Every probe resource was deleted; no leftovers.

- **Billing, KV, D1 and AI Gateway**: every listed call succeeded. The account's only rate plan is
  `ssl_for_saas_basic`: it has no Workers Paid plan.
- **R2 not enabled**: list and create both answer HTTP 403 with code 10042 even with Workers R2
  Storage: Edit, as the installer assumes (`R2_NOT_ENABLED_CODE`).
- **D1 refuses `params` on a multi-statement `/query` request.** A multi-statement request without
  `params` runs as one batch: a failing statement rolls the others back and leaves no table. The
  installer used to send a migration and its ledger row as one request with `params`, which would
  have failed every D1 migration on a live account; it now inlines the ledger's ID and digest,
  which the manifest schema limits to characters that need no quoting.
- **Cron Triggers**: `PUT .../schedules` was refused with HTTP 403, code 10063, on this account,
  which has no Workers Paid plan. On the owner account (Workers Paid) the installer token read a
  district Worker's schedules back during SCHO-243's prairie plan.

## Not yet verified, to check in the G2 sandbox

The sandbox token holds every account permission above since 2026-11-02. What is left needs an
account on Workers Paid, or the public OAuth client:

- Every OAuth scope, and every API token permission not marked verified above.
- The qualifying Workers Paid rate plan IDs: the sandbox account has none to observe.
- The schedules endpoint ([Cron Triggers](#cron-triggers)) on a Workers Paid account: replace, that
  an upload keeps the schedules, and its error code for a bad expression. Reading them is verified.
