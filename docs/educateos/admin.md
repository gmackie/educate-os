# The EducateOS admin (hosted and open source)

- Status: the ops protocol and the admin package (Worker, D1 schema, API, SPA), tested against a
  fake district; and the district side of `/api/ops/*`, its keyring, audit log and analytics proxy,
  with district /admin → Operations (see [The district side](#the-district-side)). The hosted
  edition's production config, the import of educateos.io's operators and installations, and the
  redirect of educateos.io/app are in place ([runbook](runbooks/admin-hosted.md)). Not deployed: the
  hosted admin isn't provisioned, and no production district has `/api/ops` as an Access bypass path
  yet. The installer installs the OSS admin into a district's account on request
  ([Install the OSS admin](#install-the-oss-admin)); no district has one yet.
- Issue: SCHO-263 (phase 5 of SCHO-257). Plan: `docs/plans/2026-10-28-educateos-one-domain-design.html`,
  section 6.
- Code: `packages/educateos-admin` (Worker + D1 + SPA), and the protocol in
  `packages/educateos-fleet/src/ops` (`@educateos/fleet/ops`).

The admin is the operations console for districts: workspaces and their health, Cloudflare stats,
releases, users and devices, and an audit log. Academic administration (roster, classes, guardians,
curriculum, AI budgets, term rollover) stays in each district's own `/admin`.

## Two editions, one package

| | Hosted | Open source |
| --- | --- | --- |
| Where | admin.educateos.io, in the EducateOS account | its own Worker + D1 in the district's account, by default `admin.<district domain>` |
| Manages | every district that opts in | the district(s) in the same account, listed in `OSS_WORKSPACE_ORIGINS` |
| `EDITION` | `hosted` | `oss` (the default) |

Both editions are the same code, and both talk to districts only through the signed
`/api/ops/*` API. Neither ever holds a district's Cloudflare credentials.

### Configuration

| Name | Kind | Meaning |
| --- | --- | --- |
| `DB` | D1 binding | The admin's database (`migrations/`). |
| `ASSETS` | assets binding | The built SPA (`dist/`). |
| `ACCESS_ISSUER`, `ACCESS_AUD` | vars | The Cloudflare Access team and this admin's Access application. Every `/api` request's assertion is verified (RS256, issuer, audience, expiry) with the control plane's verifier (`@educateos/control-plane/access`). |
| `ADMINS` | var | Who may use the admin: email addresses or Access subjects, comma-separated; append `:viewer` for read-only. Empty admits nobody. |
| `EDITION` | var | `hosted` or `oss`. |
| `OSS_WORKSPACE_ORIGINS` | var | OSS only: the `https://` origins the admin may manage. Anything else is refused at enrollment and hidden if already in D1. |
| `ADMIN_KEY_ENCRYPTION_KEY` | secret | 32 random bytes, base64url. Seals each workspace's ops private key in D1 (AES-256-GCM, bound to the workspace and key ID). |
| `CONTROL_PLANE` | service binding | Hosted only: the `educateos-site` Worker's `ControlPlaneExporter` entrypoint, the read-only export the import reads. Unbound, the import answers 503. |

The hosted edition sets `ADMINS` as a secret rather than a var, so the operators' addresses stay out
of the public repository.

## What D1 holds, and what it never holds

`migrations/0001_initial.sql`:

- `operators`: Access subject, email, role. The only personal data in the database, and it is the
  operators' own.
- `workspaces`: ID, slug, display name (the district's), origin, edition, enrolment time, status.
- `ops_keys`: per workspace, the key ID, the public JWK and the sealed private key.
- `analytics_snapshots`: the last analytics report per workspace and window (`24h`, `7d`, `30d`).
  Aggregates only, validated against `OpsAnalyticsResponse` before they are stored. Served for
  five minutes; after that the district is asked again, and the old snapshot is shown (marked
  stale) only if the district can't be reached.
- `audit_log`: operator, workspace, action, target (an opaque ID: `prn_…`, a device ID, a version),
  result, time.

`migrations/0002_control_plane.sql` (hosted edition, SCHO-263) adds educateos.io's records:

- `operators` gains `account_id` (the control-plane account, `acct_…`) and the role `installer`:
  someone who installed through educateos.io whom `ADMINS` doesn't list. Signing in here replaces it
  with the role `ADMINS` gives.
- `installations`: instance ID, the workspace it maps onto, the installing operator's subject, slug,
  managed hostname, Cloudflare account ID, release, install and import times.
- `slug_reservations`: a mirror of the guided install's reservations. educateos.io stays
  authoritative for them.

User lists and device details pass through from the district to the operator's browser and are
never written down. `__tests__/schema.test.ts` fails if a column named like personal data appears
outside `operators` (the workspace display name is allow-listed), and `__tests__/passthrough.test.ts`
reads every table after a session of directory and device calls and finds none of the district's
names, emails or device labels.

## The ops protocol

`@educateos/fleet/ops` is shared by both sides. It reuses the fleet's Ed25519 identities
(`SigningIdentity`, key IDs derived from the key) and base64url encoding, and runs on Web Crypto
in workerd and Node.

Each request carries five headers:

| Header | Value |
| --- | --- |
| `educateos-ops-key-id` | `ed25519-<sha256 of the public key>` |
| `educateos-ops-ts` | Unix seconds |
| `educateos-ops-nonce` | 16 random bytes, base64url |
| `educateos-ops-operator` | the acting operator (their email) |
| `educateos-ops-signature` | Ed25519 over the lines below |

The signed bytes are `educateos-ops/v1`, the method, the path and query exactly as sent, the
base64url SHA-256 of the body, the timestamp, the nonce, the key ID and the operator, joined by
newlines. The district's verifier (`createOpsVerifier`) looks the key up by ID in its own keyring
(never trusting a key sent with the request), checks the signature, the age (±60 s) and that the
nonce is new (through an injected `NonceStore`, which must claim atomically), and then that the
key holds the route's scope. A bad signature never consumes a nonce.

Scopes and routes (`OPS_ROUTES`):

| Route | Scope |
| --- | --- |
| `GET /api/ops/health` | `health` |
| `GET /api/ops/analytics?range=24h\|7d\|30d` | `analytics` |
| `GET /api/ops/directory?query&role&status&cursor`, `GET /api/ops/directory/:principal` | `directory:read` |
| `POST /api/ops/directory/:principal/(suspend\|restore\|sign-out-everywhere\|roles\|ai-access)` | `directory:write` |
| `GET /api/ops/devices?principal&status&cursor`, `POST /api/ops/devices/:id/revoke`, `POST /api/ops/devices/revoke-below-version` | `devices` |
| `GET /api/ops/releases` | `releases` |

A path outside the table is refused whatever the key's scopes. Request and response bodies are
strict Zod schemas in `src/ops/schemas.ts`; analytics are aggregates only (per-Worker invocations,
errors and CPU p50/p99; HTTP requests by status; Durable Object requests and storage; R2 and D1
storage; AI requests, tokens and cost from AI Gateway beside the guard ledger, which is
authoritative; Access sign-ins by method and failures) with a `sampled` flag, so the SPA labels
figures from Cloudflare's adaptive datasets as estimates.

The admin never follows a redirect from a district: a 3xx on `/api/ops/*` means the path isn't an
Access bypass there, and following it would send a signed request elsewhere.

## educateos.io's installations (hosted edition)

The hosted admin is the system of record for the operators, workspaces and installations that
educateos.io's control plane used to keep in its Durable Object. They move by an import:
`POST /api/import/control-plane` (admin role; `{"dryRun": true}` reports without writing, its audit
entry included), run from the Workspaces page or with `node scripts/educateos-admin-import.ts
[--dry-run]`. The admin reads the control plane's export over its `CONTROL_PLANE` service binding;
the export is an RPC entrypoint with no URL, and it only reads. The import compares and writes only
what differs, in one D1 batch, so running it again changes nothing unless educateos.io has something
new. Each installation maps onto a workspace with origin `https://<hostname>`: a workspace with the
same slug and origin is matched, a new one is made pending with its own ops key (as an enrollment
would), and one whose slug or origin another workspace holds is reported as skipped.
`GET /api/installations` lists them.

The guided install stays on educateos.io (`/app/install`), because it runs inside the site Worker
beside the release bucket and the reservations Clever launches and the registry depend on. The
Workspaces page links to it ("Install a new workspace"), and a later import brings the new
installation in. See [control-plane.md](control-plane.md#moving-to-the-admin-scho-263).

## Districts without the ops API

Until a district serves `/api/ops/*` (a later phase 5 PR), every call to it is answered
`424 {"code":"ops-not-enabled"}`, and the SPA shows "Operations not enabled for this workspace" as a
notice in place of the panel, with no error banner or retry. The admin reads a district's answer that
way when Access redirects the call, when a route with no identifier in its path is a 404, and when a
401, 403 or 404 doesn't carry the protocol's error body. A 404 with the protocol's body on a route
that names something (a person, a device) is still "not found", and a 401 or 403 with it is still a
refusal. At most 4 KiB of an error body is read.

## Enrollment

1. An operator enrolls a district in the admin (Workspaces → Enroll) with its name, slug and origin.
   The admin generates an Ed25519 key pair for that workspace, seals the private key into D1, and
   shows the registration: this admin's origin, the key ID, the public key and the scopes it asks
   for, with the steps below.
2. A district administrator opens the district's `/admin` → Operations, pastes the registration
   under Enroll an admin and chooses which scopes to grant. The district keeps its own audit log of
   every ops request, and can drop any scope or remove the admin at any time; opting out leaves a
   working district. To rekey, enroll the new key and remove the old one.
3. The operator chooses Verify connection: the admin makes a signed health call, and the workspace
   becomes active.

Every command an operator sends (suspend, restore, sign out everywhere, roles, AI access, revoke a
device, revoke below a version) is written to the admin's audit log with its outcome, including
refusals and unreachable districts; the district records the same request in its own.

## The district side

`packages/educateos-district-app/src/ops.ts` (`DistrictOps`) serves `/api/ops/*` in the district
application, before any Access-based route: the path is an Access bypass, so the signature is the
only credential. One choke point verifies every request with `createOpsVerifier` (±60 s, the route
table's scope) against the district's own keyring, and claims each nonce atomically in the
district's Durable Object (`educateos_ops_nonces`: a primary key on key and nonce, with expired rows
deleted in the same transaction).

| Table | Holds |
| --- | --- |
| `educateos_ops_keys` | key ID, public JWK, granted and requested scopes, label, admin origin, enrolled at and by (a principal), removed at and by |
| `educateos_ops_nonces` | key ID, nonce, expiry |
| `educateos_ops_audit` | ID (the `auditId` actions answer with), key ID, operator (from the signed header), route, target, result, time; kept 400 days |

Every request whose signature verified is recorded, including refusals for scope, route or replay;
a request that never verified is not, since its operator header is nobody's word.

What each route does at the district:

- `health`: release version (`SCHOOL_MANIFEST.release`, else the Worker's version tag), commit, and
  counts (people, schools, classes, active devices) in its components.
- `directory`: the district's principals (not service principals). Roles are the principal's kind
  plus `admin` for a district administrator; `rostered` when a roster owns principals; status
  `suspended` for anyone not active. AI access is `standard` (`none` for guardians): the district has
  no per-person AI setting.
- `suspend` / `restore`: the principal's existing `inactive` / `active` status; suspending also
  revokes every device (`principal-inactive`). `sign-out-everywhere` revokes every device. `roles`
  grants or revokes district administration (`admin`), refusing the last administrator; `staff`, and
  `ai-access`, answer 501 with reason `not-supported`.
- `devices`: phones (iOS and Android) only; revoke one, or every phone below a version (a forced update).
- `releases`: the current version and channel; `available` is empty until the district reads the registry.
- `analytics`: `ops-analytics.ts` reads `workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`,
  `durableObjectsStorageGroups`, and with `ANALYTICS_ZONE_TAG` `httpRequestsAdaptiveGroups`, plus the
  Access authentication log, with the district's `CF_ANALYTICS_TOKEN`; caches each window for five
  minutes in the object; and adds AI figures from the district's own ledger. Without a token it
  answers 501 `analytics-not-configured`. R2 and D1 bytes are 0: the district Worker has neither.

Refusals carry `{ code, reason, message }`, where `reason` is the verifier's (`stale`, `replayed`,
`scope-denied`, ...) or `not-supported`, `analytics-not-configured`, `analytics-unavailable`.

District /admin → Operations (`packages/educateos-admin-ui/src/operations`) lists the enrolled admins,
enrolls one from the registration the admin shows (pasted as it is; the administrator ticks the
scopes to grant, among those it asked for), removes one, and shows the recent ops log. Its routes
(`admin.opsKeys`, `admin.enrollOpsKey`, `admin.setOpsKeyScopes`, `admin.removeOpsKey`,
`admin.opsAudit`) need `configure` on the district's `capability-config`: a district administrator.

## Running and deploying

Locally: `pnpm exec vp run -F @educateos/admin build`, then
`wrangler d1 migrations apply DB --local -c wrangler.local.jsonc` and
`pnpm --filter @educateos/admin dev:worker`. The config is `wrangler.local.jsonc`, not
`wrangler.jsonc`, so release discovery, the staging, preview and production config generators and
the dev server ignore it.

Deployment isn't wired yet:

- Hosted: `wrangler.production.jsonc` is admin.educateos.io, deployed only by its own ForgeGraph app
  `educateos-admin`. It is hand-written, and the package has no `wrangler.jsonc`, so nothing else
  picks it up (`scripts/educateos-admin-config.test.ts`). Its D1 ID and Access audience are
  placeholders until [the runbook](runbooks/admin-hosted.md) provisions them, then the import runs
  and `ADMIN_URL` on the site Worker redirects educateos.io/app here.
- OSS: every district release carries the admin, and the installer installs it when the install
  config asks for it. See [Install the OSS admin](#install-the-oss-admin).

## Install the OSS admin

A district that runs its own install (`packages/educateos-installer`) can put the open-source admin
in its own Cloudflare account beside the district. Add this to the install config:

```json
"admin": { "enabled": true }
```

or, for a hostname other than `admin.<base domain>`, `"admin": { "enabled": true, "hostname":
"ops.northfield.example" }`. The hostname must be in the base domain's zone (the installer attaches it
there) and must not be the district's own. The admin manages the district through `/api/ops/*`, so
it needs a one-origin install: the district service enabled, from a release that wires it.

The installer then adds, with the instance's prefix (`educateos-<slug>-…`):

| Resource | What it is |
| --- | --- |
| Worker `educateos-<slug>-educateos-admin` | The admin, with `EDITION=oss`, `OSS_WORKSPACE_ORIGINS` set to the install's public origin (`https://<subdomain>.<base domain>`), `ACCESS_ISSUER` from `access.teamName`, `ACCESS_AUD` from its own Access application, and `ADMINS` from the install's `admins` (comma-separated, each an admin). |
| D1 database `educateos-<slug>-admin-db` | The admin's database, with the release's `migrations/` applied through the installer's ledger like any D1 migration. Its own database: no other Worker binds it. |
| Secret `ADMIN_KEY_ENCRYPTION_KEY` | 32 random bytes, base64url, generated at the first install (as the district's `DEVICE_TOKEN_SECRET` is) and never rotated or read back. Supply one through the secret source (`EDUCATEOS_SECRET_EDUCATEOS_ADMIN__ADMIN_KEY_ENCRYPTION_KEY`) to choose it yourself. |
| Access application `educateos-<slug>-admin` | The admin's hostname, behind the install's members policy (its email domains). Access lets the district's people reach the sign-in; `ADMINS` decides who may use the admin. |
| Access application `educateos-<slug>-admin-bypass` | `<admin hostname>/healthz` only, under the install's bypass policy. |
| Custom domain | The admin's hostname on the admin Worker, attached after both applications exist. |

`installer plan` shows each of these as a step, and the preflight checks the admin's hostname for DNS
records as it does the district's. A later release updates the admin's code and applies its new
migrations like any other component, and a rollback returns it to its previous version (or, to a
release from before the admin, leaves it running). `admin.enabled: false`, the default, leaves the
install exactly as it was. It doesn't remove an admin installed earlier either: to remove one, delete
the Worker, the two Access applications and, once nothing in it is needed, the D1 database, in the
Cloudflare dashboard.

The installer can't enroll the admin with the district itself. The admin makes each workspace's
ops key pair when an operator enrolls it, sealed under a key the installer generated and does not
keep, and the district records which of its administrators enrolled each key. So enrollment is the
same three steps as for any admin, which the CLI prints after the install as next steps:

1. Open the admin at `https://admin.<base domain>` as one of the install's `admins` and enroll the
   district under Workspaces → Enroll, with the install's public origin.
2. Copy the registration it shows, open the district's `/admin` → Operations, paste it under Enroll
   an admin, and grant the scopes it asks for.
3. In the admin, choose Verify connection.

The release side: the admin has no `wrangler.jsonc`, so release discovery doesn't find it.
`scripts/release/manifest-lib.ts` lists it in `RELEASE_COMPONENTS`; `build-release.ts` builds its SPA
(`vp run -F @educateos/admin build`) and bundles it from `wrangler.release.jsonc`, the config template
(`EDITION=oss`, the `DB` binding, the assets, nothing account-specific). Its manifest entry has kind
`admin`, its SPA as the one asset variant `spa`, its migrations as content-addressed blobs, and
`ADMIN_KEY_ENCRYPTION_KEY` as a generated secret input (`deploy-inputs.json`).
