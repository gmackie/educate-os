# The EducateOS admin (hosted and open source)

- Status: the ops protocol and the admin package (Worker, D1 schema, API, SPA), tested against a
  fake district. Not deployed. The district side of `/api/ops/*`, the analytics proxy, the hosted
  deployment at admin.educateos.io and the installer's OSS admin come in later phase 5 PRs.
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

## Enrollment

1. An operator enrolls a district in the admin (Workspaces → Enroll) with its name, slug and origin.
   The admin generates an Ed25519 key pair for that workspace, seals the private key into D1, and
   shows the registration: this admin's origin, the key ID, the public key and the scopes it asks
   for, with the steps below.
2. A district administrator opens the district's `/admin` → Operations → Admin access, adds the
   registration and chooses which scopes to grant. (District side: a later phase 5 PR. It reuses the
   fleet registration and rekey protocol, keeps its own audit log of every ops request, and can drop
   any scope or remove the admin at any time; opting out leaves a working district.)
3. The operator chooses Verify connection: the admin makes a signed health call, and the workspace
   becomes active.

Every command an operator sends (suspend, restore, sign out everywhere, roles, AI access, revoke a
device, revoke below a version) is written to the admin's audit log with its outcome, including
refusals and unreachable districts; the district records the same request in its own.

## Running and deploying

Locally: `pnpm exec vp run -F @educateos/admin build`, then
`wrangler d1 migrations apply DB --local -c wrangler.local.jsonc` and
`pnpm --filter @educateos/admin dev:worker`. The config is `wrangler.local.jsonc`, not
`wrangler.jsonc`, so release discovery, the staging, preview and production config generators and
the dev server ignore it.

Deployment isn't wired yet:

- Hosted: a later PR adds admin.educateos.io (its D1, Access application and ForgeGraph app), moves
  the control plane's operators and installations from the ControlPlane Durable Object into D1, and
  redirects educateos.io/app there.
- OSS: the installer (`packages/educateos-installer/src/desired.ts`) will add the admin Worker, its
  D1 database, the migrations, an Access application and `ADMIN_KEY_ENCRYPTION_KEY` to the district's
  account, with `EDITION=oss` and `OSS_WORKSPACE_ORIGINS` set to the district's origin, and register
  the admin's key with the district during the install.
