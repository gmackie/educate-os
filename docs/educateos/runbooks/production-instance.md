# Runbook: the schoolos.gmac.io production instance

- Issues: SCHO-192 (the instance), SCHO-193 (the LMS-lite district), SCHO-214 (the Google
  connector), SCHO-218 (the EducateOS connector).
- Instance: <https://schoolos.gmac.io>, one long-lived EducateOS deployment on the gmacko Cloudflare
  account (`c07a7e704db1808e1fff91bed2b1cd49`), deployed by ForgeGraph.
- Configs: `packages/<worker>/wrangler.production.jsonc`, generated and committed.
- Generator: `scripts/production/production-config.ts`. The instance's values are in
  `scripts/production/schoolos-gmac-io.ts`. The guard's configuration is the `AI_GUARD_CONFIG`
  secret, whose public example is `deploy/schoolos-gmac-io/ai-guard-config.example.json`.

This layout is changing. [ADR-0014](../adr/0014-one-origin-per-district.md) moves each district to one
origin: the router serves `northfield.educateos.io`, with the LMS at `/` and the Workshop at `/ai`,
behind one Access application, and the two hostnames below answer with 301s. Until the Northfield
cutover lands, the production configs don't bind the router's `DISTRICT`, and this runbook
describes what is deployed. The cutover is prepared behind switches that are off; its steps are in
[the one-origin cutover runbook](one-origin-cutover.md).

The instance is synthetic. Its AI call guard serves a demo district with a single staff principal,
and legal review (SCHO-118) must pass before any real student uses it.

## The Workers

Every Worker is named after its package and has `workers_dev` and `preview_urls` off. Two have a
hostname, each a custom domain behind its own Access application: the router at `schoolos.gmac.io`,
and the district Worker at `district.schoolos.gmac.io` (see [The district](#the-district-lms-lite)).
Every other Worker is reached only through the router.

| Worker | Config | Binds |
|---|---|---|
| `router` | `packages/router/wrangler.production.jsonc` | `WORKSHOP_BACKEND`, `GATEKEEPER_{CONTEXT,GOOGLE,SCHEDULER,EDUCATEOS,WEBSEARCH}`, and the Access-mode frontend as `ASSETS` |
| `workshop-backend` | `packages/workshop-backend/wrangler.production.jsonc` | The five gatekeepers' `GatekeeperVendor` entrypoints (context gets `props.sharingDomain` = the origin), `AI_CALL_GUARD` → `educateos-ai-guard#EducateOsAiCallGuard`, `WORKERS_AI`, KV `BLUEPRINTS` and `AVATARS`, R2 `BLUEPRINT_CONTENT` (`schoolos-prod-blueprint-content`), `BROWSER`, `LOADER` |
| `gatekeeper-context` | `packages/gatekeeper-context/wrangler.production.jsonc` | KV `CONTEXT_COLLECTIONS` |
| `gatekeeper-google` | `packages/gatekeeper-google/wrangler.production.jsonc` | none (its Durable Objects need no binding); the OAuth client is its `CLIENT_ID` and `CLIENT_SECRET` secrets. See [The Google connector](#the-google-connector). |
| `gatekeeper-scheduler` | `packages/gatekeeper-scheduler/wrangler.production.jsonc` | none |
| `gatekeeper-educateos` | `packages/gatekeeper-educateos/wrangler.production.jsonc` | `EDUCATEOS_DISTRICT` → `educateos-district-worker#DistrictSchoolTools`. See [The EducateOS connector](#the-educateos-connector). |
| `gatekeeper-websearch` | `packages/gatekeeper-websearch/wrangler.production.jsonc` | `AI`, with `CF_AI_GATEWAY=default` |
| `educateos-ai-guard` | `packages/educateos-ai-guard/wrangler.production.jsonc` | `HALL_MONITOR` → `hall-monitor` (already in the account). It runs its production entrypoint `src/worker.ts` with the nightly `17 3 * * *` reconciliation cron. |
| `schoolos-district-worker` (package `educateos-district-worker`; name pinned, see [The district](#the-district-lms-lite)) | `packages/educateos-district-worker/wrangler.production.jsonc` | `SEND_EMAIL` (Email Service), the district's UIs as static assets, and its two Cron Triggers. Its Durable Object needs no binding. |

The backend's vars are `PUBLIC_BASE_URL`, plus `CF_AI_GATEWAY=default`, `CF_AI_GATEWAY_ACCOUNT_ID`
and `CF_AI_GATEWAY_PROVIDERS=cloudflare`. With these, Workers AI is server-managed through the
account's default gateway, over the `WORKERS_AI` binding, so no API token is needed. Each gatekeeper
gets `BASE_URL=https://schoolos.gmac.io/gatekeeper/<short>`.

The guard reaches Hall Monitor by service binding, which it prefers over `HALL_MONITOR_URL`, so that
var is not set. It signs its service tokens as `iss=educateos`, `aud=hall-monitor`, for tenant
`educateos-gmacko-demo`. Hall Monitor (hall-monitor.gmac.io, HM-12) trusts that issuer with the
public half of the signing key (`kid` `educateos-1`). The guard config names Hall Monitor's built-in
profiles at revision `builtin-1`: `educator`, `student-9-12`, and `student-6-8` for both the 6-8 and
K-5 audience classes (Hall Monitor has no younger profile and moderates younger bands under the
stricter 6-8 one). The guard's optional AI Gateway log reader (`AI_GATEWAY_ACCOUNT_ID`,
`AI_GATEWAY_ID`, `AI_GATEWAY_LOGS_TOKEN`) is left unset, so settlements are estimated, and the nightly
reconciliation only records snapshots.

## Secrets (delivered by ForgeGraph, never in a config)

| Worker | Secret | ForgeGraph app |
|---|---|---|
| `workshop-backend` | `ADMINS` (a JSON array of Access emails), `CF_ACCESS_AUD`, `CF_ACCESS_ISS` | `educate-os` |
| `educateos-ai-guard` | `HALL_MONITOR_SIGNING_KEY` (private Ed25519 or P-256 JWK, with a `kid`), `AI_GUARD_CONFIG` (the example config with the admin's Access email in place of `admin@example.com`, minified) | `educateos-ai-guard` |
| `schoolos-district-worker` | `DISTRICT_CONFIG` (the demo district's seed, minified), `CF_ACCESS_AUD` (comma-separated: the district Access application's audience, then the instance's; see [The EducateOS connector](#the-educateos-connector)), `CF_ACCESS_ISS` | `educateos-district` |
| `gatekeeper-google` | `CLIENT_ID` and `CLIENT_SECRET` (the educateos-classroom-demo OAuth web client) | `educateos-google` |

The guard, the district, the Google connector and the EducateOS connector are each their own ForgeGraph app because
ForgeGraph's `syncSecrets` copies every secret of a stage onto each target that sets it: in one app,
the backend would also receive the guard's signing key, the district would receive the backend's
Access audience in place of its own, and the backend would receive the Google OAuth client. The
EducateOS connector has no secrets; it is its own app, `educateos-gatekeeper`, as the Google connector
is. `AI_GUARD_CONFIG` is a secret rather than a var because it names the admin's Workshop user,
and this repository is public.

Setting the Access pair also closes password sign-in. The generator refuses to emit any of these
names as a var.

## Who the guard knows

Without a principal resolver bound, an Access sign-in's Workshop user ID is the Access JWT's `email`
claim, verbatim (`authenticateFromCfAccess` in `workshop-backend/src/server.ts`, then
`users.idFromName(email)`; the user's profile `id` is that email). The kernel sends this ID as
`AiCallDescriptor.initiator.id`. A gadget's calls carry its owner's ID. So the guard config
(`contextSource: "static"`) binds the admin's Access email to `prn_gmacko-demo-admin`. That is an
`educator`-audience staff principal in the synthetic district `dst_gmacko-demo`, billed to a
personal workspace. Its profile moderates input and proceeds if Hall Monitor is down; output is not
moderated. Any other Workshop user is refused with `unknown_principal`. The match is exact, so if
Access ever sends a differently cased email, the binding needs updating.

The budget is $5 a month for personal workspaces and $1 a month for the safety pool, with a cap of
500 cents per principal. Every Workers AI model the Workshop suggests is priced. The four chat
models use a deliberately high demo rate ($1 in and $4 out per million tokens). The Clef decision
models use the shared Cloudflare price book.

## Principal identity cutover (SCHO-259)

Today no principal resolver is bound, so Workshop users are keyed by Access email (above). On a
district origin the Workshop resolves the same principal as the district: the backend's
`PRINCIPAL_RESOLVER` service binding names the district Worker's `DistrictPrincipalResolver`
entrypoint, and an Access sign-in names its user Durable Object `principal:<id>` (ADR-0003, ADR-0014).
A subject the district has not linked is refused ("Your school hasn't set up your account here
yet"). If the district cannot be reached, every sign-in is refused with a retryable message until
it is back. Binding the resolver also turns off session-token, password and gatekeeper sign-in.

Existing email-keyed users keep their data through an alias, not a copy: see
[ADR-0003](../adr/0003-principal-identity.md#migrating-email-keyed-workshop-users-scho-259). Run
the migration before binding the resolver. A principal that signs in first gets its own empty
account, and the migration then refuses to alias over it.

1. **Bind the migration directory.** Add a service binding to the backend's config,
   `{ "binding": "PRINCIPAL_MIGRATION", "service": "schoolos-district-worker", "entrypoint":
   "DistrictPrincipalResolver" }`, and deploy. Sign-in does not change. The district Worker must be
   on a release that exports the entrypoint. Until something is bound,
   `/api/admin/principal-migration` is Not Found.
2. **Dry run.** As a Workshop administrator (your Access email is in `ADMINS`):

   ```sh
   cloudflared access login https://<host>/ai
   CF_ACCESS_TOKEN=$(cloudflared access token --app https://<host>/ai) \
     node scripts/principal-migration.ts --workshop https://<host>/ai --dry-run
   ```

   This writes nothing. It lists every email-keyed user in the Workshop's user directory, with its
   thread (workspace) count and outcome. `alias` means exactly one district person has the email.
   `ambiguous`, `cross-district` and `unmatched` users are not aliased, and after the cutover they
   start a new account. `conflict` names a reason. Check the mapping and the counts. A user who has
   not signed in since the user directory was added is not listed: have them sign in once first.
   Save the output (`--json`) as the before-count.
3. **Apply.** Run the same command with `--apply`. Each entry then also shows
   `threadsViaPrincipal`, its threads counted again through the alias. A second `--apply` reports
   `already-aliased` and writes nothing new. Old Durable Objects are not touched.
4. **Bind the resolver.** Add the same entrypoint as `PRINCIPAL_RESOLVER` (keep or drop
   `PRINCIPAL_MIGRATION`) and deploy. Aliased users keep their email as their user ID, so `ADMINS`
   and the guard's `AI_GUARD_CONFIG` bindings for them stay valid. A new user is
   `principal:<id>`, and `ADMINS` or the guard config must name it that way.
5. **Verify.** Run `--apply` again (still `already-aliased` only, and `threadsViaPrincipal` equals
   `threads` for every aliased user; the script warns otherwise). Then sign in as one migrated
   user and check that their threads are there.

To roll back, unbind `PRINCIPAL_RESOLVER`. Sign-in returns to email keys, and the aliases are
ignored while it is unbound.

## Build and deploy

ForgeGraph runs `buildCommand` and then `deployCommand`, both in the config's directory. Run
`pnpm install --frozen-lockfile` at the repository root first. The custom `build` stanzas in the
configs call `pnpm` (capnweb-validate, the backend's `build:worker`), so `pnpm` must be on `PATH`.
Deploys rebuild from source, so every `vp run` is `--no-cache`.

Every `buildCommand` starts by stamping the commit being deployed into the config, as
`vars.FG_COMMIT_HASH` (`scripts/production/stamp-commit.ts`, from `git rev-parse HEAD` in the
deploy checkout). ForgeGraph's source-order guard refuses to deploy over a serving version that has
no `FG_COMMIT_HASH`, and its agent stamps the var only into `wrangler.jsonc`, never into the
`-c wrangler.production.jsonc` these targets deploy (FORGE-212). Without the stamp, every deploy
after the first is refused with `cloudflare_worker_source_order_refused`. The committed configs never
carry the var. A Worker already serving an unstamped version needs a one-time admin recovery:
`forge deploy create production --target <name> --ref <full sha> --recover-source-reason <why>
--recover-serving-deployment <id> --recover-serving-version <id>`, using the IDs of its sole 100%
version (`wrangler deployments list`).

| Worker (cwd) | `buildCommand` | `deployCommand` |
|---|---|---|
| `packages/gatekeeper-context` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache -F @gadgets/typed-storage build && pnpm exec vp run --no-cache build:app` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/gatekeeper-scheduler` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache build:app` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/gatekeeper-websearch` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc` (Wrangler's own build runs capnweb-validate) | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/gatekeeper-educateos` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && if [ -f build-app.ts ]; then pnpm exec vp run --no-cache build:app; fi` (the School app, SCHO-218; the guard kept commits from before it deployable. Wrangler's own build runs capnweb-validate; its `types.txt` is committed) | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/gatekeeper-google` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache build:configurator` (the configurator frames; Wrangler's own build runs capnweb-validate) | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/educateos-ai-guard` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc` (Wrangler's own build runs capnweb-validate) | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/workshop-backend` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache -F @gadgets/typed-storage build && pnpm exec vp run --no-cache build:bundled-blueprints` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/educateos-district-worker` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && VITE_CF_ACCESS_MODE=true pnpm exec vp run --no-cache -F @educateos/student-ui build && EDUCATEOS_UI_BASE=/admin/ pnpm exec vp run --no-cache -F @educateos/admin-ui build && EDUCATEOS_UI_BASE=/teach/ pnpm exec vp run --no-cache -F @educateos/teacher-ui build && node ../../scripts/production/assemble-district-ui.ts` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/router` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && VITE_CF_ACCESS_MODE=true pnpm exec vp run --no-cache -F @gadgets/workshop-frontend build` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |

`VITE_CF_ACCESS_MODE=true` is a build-time flag. Without it, the frontend serves a password form
that the backend rejects. The release build sets it the same way (`build-release.ts`).

### Cold bring-up order

A service binding needs its target to exist, so deploy in tiers:

1. `educateos-district-worker`, which binds no other Worker. `hall-monitor` must already exist.
2. `gatekeeper-context`, `gatekeeper-google`, `gatekeeper-scheduler`, `gatekeeper-educateos`,
   `gatekeeper-websearch` and `educateos-ai-guard`. They can go in parallel. `gatekeeper-educateos`
   binds the district Worker, so it needs step 1.
3. `workshop-backend`, after setting its secrets.
4. `router`, which creates the `schoolos.gmac.io` custom domain. The `gmac.io` zone must be on the
   account.

Later deploys can go in any order, as long as no binding is renamed. Adding a Worker to a running
instance is a small cold bring-up: the new Worker must be serving before the backend and router
deploy with a binding to it. See [The Google connector](#the-google-connector) for how that went for
`gatekeeper-google`, and [The EducateOS connector](#the-educateos-connector) for `gatekeeper-educateos`.

### Bindings the account must support

The backend declares `LOADER` (Worker Loader, the gadget sandbox) and `BROWSER` (Browser Rendering,
for gadget PDF export), as in its repository config. If the account lacks either, the backend
deploy fails. Enable the product rather than editing the generated config.

## Changing the instance

1. Edit `scripts/production/schoolos-gmac-io.ts` (resources, vars, gatekeepers). For the guard
   config, edit `deploy/schoolos-gmac-io/ai-guard-config.example.json`, then set the deployed copy
   with the admin's email substituted:
   `forge secret set AI_GUARD_CONFIG --stage production --stdin` for app `educateos-ai-guard`. A Worker's own bindings change in its
   `cloudflare.config.ts`, as usual (`pnpm configs:generate` first).
2. Run `pnpm production:configs` and commit the regenerated `wrangler.production.jsonc` files.
   `pnpm production:check`, which is part of `pnpm lint`, fails on drift. The generator fails
   closed in three cases: a Worker declares a KV or R2 binding the instance names no resource for,
   the instance names one the Worker does not declare, or a var has a secret's name.
3. The guard config must stay under 5 KB, the limit for one Workers secret. It must also parse with
   `readGuardConfig`. `packages/educateos-ai-guard/__tests__/demo-config.test.ts` checks both, and
   checks that every suggested Workers AI model is priced.
4. Check each config with
   `pnpm exec wrangler deploy -c wrangler.production.jsonc --dry-run --outdir <tmp>`, run from the
   package directory after its `buildCommand`.

## The district (LMS-lite)

SCHO-193 adds the LMS-lite district application: the package `educateos-district-worker`, deployed
as the Worker `schoolos-district-worker`, for the demo co-op, at `https://district.schoolos.gmac.io`.
The router sends `/api/*` to the Workshop backend, so the district has its own hostname, behind its
own Access application. Since SCHO-207 it is also at its managed default hostname,
`https://northfield.educateos.io`. That is a second custom domain on the same Worker (`aliases` in
`scripts/production/schoolos-gmac-io.ts`), possible because the educateos.io zone is in this account
(see [the spike](../spikes/managed-hostnames-cloudflare.md)). It is routing only: the district's
identity, and every link it sends, stays `district.schoolos.gmac.io`. The five other demo districts are separate
district Workers at their own `<slug>.educateos.io`; see [the demo districts runbook](demo-districts.md).

- **Its Worker name is pinned.** The Worker was deployed as `schoolos-district-worker` before the
  EducateOS rename (SCHO-200), and keeps that name (SCHO-231). A Durable Object namespace belongs to
  its Worker's name, so deploying the district under its package's new name would start it empty
  beside the real one, which keeps the custom domain. A deployed Worker's name is production
  identity, like a hostname or a ForgeGraph app slug. The instance pins it in `workerNames` in
  `scripts/production/schoolos-gmac-io.ts`. The generator applies the pin to the Worker's own
  `name` and to every service binding that reaches it. `production-config.test.ts` fails if any
  Worker that owns Durable Objects would deploy under a name other than the one recorded there.
  The AI call guard is not pinned: it was redeployed as `educateos-ai-guard` with a fresh ledger,
  and the old `schoolos-ai-guard` Worker is to be deleted.

- **What it serves.** The Worker runs first for `/api/*` (the district's API, verified against its
  own Access audience) and `/healthz` (a liveness probe that reads nothing). Everything else is
  static assets, laid out at deploy time by `scripts/production/assemble-district-ui.ts`. The student
  Learning Home, path-routed, is at `/` with the single-page fallback. The admin console is at
  `/admin/` and Teacher Studio at `/teach/`. Both route by hash and are built with
  `EDUCATEOS_UI_BASE` set to their prefix. The student build sets `VITE_CF_ACCESS_MODE=true`, so it
  takes no development `?token=`: Access signs its requests. Guardians use the student app's family
  view.
- **State.** One SQLite Durable Object holds the district (see the package README), so a deploy
  never touches its data.
- **Access.** The application `EducateOS district (demo co-op)` covers the hostname, with a bypass
  application for `district.schoolos.gmac.io/healthz`. Its audience is the first entry of the
  district's `CF_ACCESS_AUD`; the second is the instance's (see
  [The EducateOS connector](#the-educateos-connector)). The issuer is the same team domain as the
  instance's. Both applications also list `northfield.educateos.io` (and its `/healthz`) as a second
  destination, so the alias is protected by the same policies and carries the same audience, and
  `CF_ACCESS_AUD` did not change. Add an alias to both applications before deploying it: Wrangler
  attaches every custom domain in the config, and one that no application lists would serve without
  Access. The destinations were added with the API (`PUT /accounts/<id>/access/apps/<app>` with the
  full application and the extra `destinations` entry), since the applications predate the installer.
- **Who it knows.** `DISTRICT_CONFIG` seeds the directory on first start only: the district
  (`authority: "local"`, so its administrators build classes rather than importing a roster) and its
  administrator, matched by the Access subject (`sub`) their sign-in carries, not by email. Every
  other principal is created through the admin console after they first sign in, since inviting by
  email before a first sign-in is not built yet. Someone who signs in before they are added sees
  their sign-in ID (the Access `sub`) on the Learning Home, Teacher Studio or admin console, ready
  to copy and send to an administrator, who enters it under "Manage classes and people". The demo's test identities are addresses on a test mail
  domain the operator controls, admitted by a reusable Access policy attached after the owner's on
  both applications. They sign in with the one-time PIN, whose code arrives in an inbox the
  operator's agents can read, so scenarios run without a person. The public example is
  `deploy/schoolos-gmac-io/district-config.example.json`. The deployed copy puts the administrator's
  Access `user_uuid` (from `/cdn-cgi/access/get-identity`, which is the assertion's `sub`) in place
  of the zero subject, minified:
  `forge secret set DISTRICT_CONFIG --stage production --stdin` for app `educateos-district`.
  `__tests__/demo-config.test.ts` in the package checks that the example parses and fits in a
  secret. The seed is read only on the object's first start.
- **Bound by the connector only.** `gatekeeper-educateos` binds `DistrictSchoolTools` (SCHO-218).
  The guard keeps its configured directory: binding its `EDUCATEOS_DISTRICT` to
  `DistrictGuardDirectory` would resolve Workshop users through the district's identity links, which
  the instance's admin does not have (SCHO-147). The backend's `EDUCATEOS_DISTRICT_API` is left out
  too, since nothing routes to it.
- **Email.** `DISTRICT_CONFIG.email.from` must be on a domain onboarded to Cloudflare Email Service
  in the account. Without `email`, notifications stay in-app and the digest is not mailed.
- **ForgeGraph.** App `educateos-district`, stage `production`, one `cloudflare-workers` target
  on hetzner-fg: `workerName` `schoolos-district-worker` (the pinned name, not the package's),
  `appDir` `packages/educateos-district-worker`,
  `configPath` `packages/educateos-district-worker/wrangler.production.jsonc`, the `buildCommand`
  and `deployCommand` in the table above, `syncSecrets: true`, and `healthCheckUrl`
  `https://district.schoolos.gmac.io/healthz`.

## The Google connector

SCHO-214 adds the Workshop's Google connector, `gatekeeper-google`, mounted at
`https://schoolos.gmac.io/gatekeeper/google`. It gives agents and gadgets Gmail, Drive, Docs,
Sheets, Slides, Calendar, Chat and BigQuery, through each user's own Google account.

- **How users get it.** The backend offers every gatekeeper it has a `GATEKEEPER_*` binding for
  (`buildGatekeeperVendorMap`); no var lists installed gatekeepers, and the release manifest's
  `gatekeeperBindingExpansion` is likewise only bindings. It is not auto-provisioned: each user
  connects their Google account from the Connectors page, through the OAuth flow. Connectors are
  on unless an admin turns them off in the `/admin` Gatekeepers panel, so nothing else needs
  configuring. Signing in with Google is separate: it is an Access identity provider, not the
  Workshop's `AUTH_GATEKEEPERS` (see "Google sign-in" below).
- **OAuth client.** A Web application OAuth client in the `educateos-classroom-demo` Google Cloud
  project, owned by the demo Workspace for Education tenant `gedu.demo.educateos.io`, with an
  **Internal** consent screen, so only that organization's accounts can connect and Google does not
  need to verify the app. Enable the APIs the connector reaches (Gmail, Docs,
  Drive, Sheets, Slides, Calendar, Chat, People, BigQuery; see the package README and
  `deploy-inputs.json`). Its authorized redirect URI is
  `https://schoolos.gmac.io/gatekeeper/google/oauth`. The same client backs the Access Google
  sign-in (SCHO-215). The client ID and secret are never written in this repository:
  `FG_APP=educateos-google forge secret set CLIENT_ID <id> --stage production` and
  `FG_APP=educateos-google forge secret set CLIENT_SECRET <secret> --stage production` (or with
  `--stdin`, to keep the secret out of shell history).
- **Access.** The redirect lands on the router's hostname, behind the instance's Access application.
  The user's browser already holds an Access session there, so no bypass is needed.
- **Not configured.** The Gmail and Chat new-message hooks (`PUBSUB_CHAT_TOPIC`,
  `PUBSUB_GMAIL_TOPIC`, `PUBSUB_PUSH_SERVICE_ACCOUNT`) are left unset, so hooks are refused and
  everything else works. Turning them on also needs an Access bypass for
  `/gatekeeper/google/pubsub` (see the package README).
- **ForgeGraph.** App `educateos-google`, stage `production`, one `cloudflare-workers` target
  `gatekeeper-google` on hetzner-fg: `workerName` `gatekeeper-google`, `appDir`
  `packages/gatekeeper-google`, `configPath` `packages/gatekeeper-google/wrangler.production.jsonc`,
  the `buildCommand` and `deployCommand` in the table above, `syncSecrets: true`, and
  `healthCheckUrl` `https://schoolos.gmac.io/healthz`.
- **Bring-up.** Set both secrets, then deploy `gatekeeper-google` first (for the first deploy,
  before this change is on `main`, with `--ref` at the change's commit). Only then may
  `workshop-backend` and `router` deploy with their new `GATEKEEPER_GOOGLE` binding; a deploy of
  either before the Worker exists is rejected.

## Google sign-in

SCHO-215 lets staff and students sign in to the instance and the district with their Workspace for
Education accounts. It is configured in Cloudflare Access only; neither Worker changes, because the
district keys people by Access subject.

- **Identity provider.** "Google (EducateOS demo)", type Google Workspace, restricted to the
  `gedu.demo.educateos.io` domain, using the connector's OAuth client above. The client lists
  `https://gmacko.cloudflareaccess.com/cdn-cgi/access/callback` as an authorized redirect URI.
  Creating or editing identity providers needs the Cloudflare dashboard (or an API token with
  Access identity-provider rights); the workspace token is refused.
- **Policy.** The reusable allow policy "EducateOS demo Google accounts" includes the email domain
  `gedu.demo.educateos.io` and requires the login method to be that identity provider, so a
  one-time PIN sent to a domain address does not satisfy it. It is attached, after the existing
  policies, to both the instance's and the district's Access applications.
- **What refuses an outside account.** Google itself: the provider passes `hd`, so its sign-in page
  only accepts the domain's accounts (another organization's address gets "Couldn't find this
  account"), and the Internal consent screen admits no one else.
- **New accounts and Google's login challenge.** A new account's first sign-in can be met by
  Google's "Verify it's you" phone challenge, which only a phone number satisfies; a recovery email
  is not offered, and an admin's "Turn off for 10 minutes" did not lift it (2026-10-26). The person
  completes it once from their own phone. "Use employee ID" (Admin console, Security,
  Authentication, Login challenges) with an employee ID on the account may replace it, but the
  phone was still required within minutes of turning it on.
- **After signing in.** The instance creates the Workshop user. The district shows "you haven't been
  added to this school yet" until an administrator adds the person under Manage classes and people,
  with "Signs in through" set to the Access team and the Access subject as the sign-in ID.

## The EducateOS connector

SCHO-218 installs the EducateOS connector, `gatekeeper-educateos` (package `@educateos/gatekeeper`),
mounted at `https://schoolos.gmac.io/gatekeeper/educateos`. A person connects their school account
from the Workshop's Connectors page; their agents then get the district's school tools as the
`SCHOOL` binding, every write waiting for a person (see the package README). It is not
auto-provisioned and takes no OAuth client.

- **How users get it.** As for the Google connector: the backend offers every gatekeeper it has a
  `GATEKEEPER_*` binding for, and connectors are on unless an admin turns them off in the `/admin`
  Gatekeepers panel.
- **The district binding.** Its `EDUCATEOS_DISTRICT` is the district Worker's `DistrictSchoolTools`
  entrypoint. The generator refuses to emit the connector for an instance with no district.
- **Access.** The connect page is on the router's hostname, behind the instance's Access
  application, so the assertion the browser carries there is for the *instance's* audience, and
  the connector hands that request to the district's `authenticate`. The district accepts it only
  because its `CF_ACCESS_AUD` lists both audiences, comma-separated: the district application's
  first, then the instance's. The two applications are on the same Access team, so a person's
  `sub` is the same in both and resolves to the same principal. Test identities must be admitted
  by both applications' policies. Set it with
  `FG_APP=educateos-district forge secret set CF_ACCESS_AUD --stage production --stdin`, entering
  `<district application AUD>,<instance application AUD>`.
- **ForgeGraph.** App `educateos-gatekeeper`, stage `production`, one `cloudflare-workers` target
  `gatekeeper-educateos` on hetzner-fg: `workerName` `gatekeeper-educateos`, `appDir`
  `packages/gatekeeper-educateos`, `configPath`
  `packages/gatekeeper-educateos/wrangler.production.jsonc`, the `buildCommand` and `deployCommand`
  in the table above, and `healthCheckUrl` `https://schoolos.gmac.io/healthz`. It has no secrets,
  so it does not sync them.
- **Bring-up.** In this order, because a deploy that binds a Worker that does not exist yet is
  rejected, and because the district must accept the instance's audience before anyone connects:
  1. Deploy `educateos-district-worker` with SCHO-218's district change (PR #108). That change reads
     `CF_ACCESS_AUD` as a list, so the district's current single audience keeps working.
  2. Set the district's `CF_ACCESS_AUD` to both audiences (above), and deploy it again so the
     secret is synced. Do not set the list before step 1: earlier code reads the whole value as
     one audience, which would lock everyone out of the district.
  3. Deploy `gatekeeper-educateos`. For the first deploy, before this change is on `main`, use
     `--ref` at the change's commit.
  4. Only after that, deploy `workshop-backend` and `router` with their new `GATEKEEPER_EDUCATEOS`
     binding. A deploy of either before the Worker exists is rejected.

## Native EducateOS sign-in

The native session handoff returns to `https://mobile.educateos.io/oauthredirect`, an app-owned
HTTPS endpoint. The phone must have both the `applinks:mobile.educateos.io` and
`webcredentials:mobile.educateos.io` associated-domain entitlements. The callback host publishes
both associations for `P4SWQXAB5H.io.educateos.mobile` without Cloudflare Access protection.

After changing this callback, deploy both `workshop-backend` (the encrypted session redirect) and
`router` (the confirmation UI and frontend auth callback). Building a new phone app alone does not
update the school server. Verify CI for the exact deployment revision and preserve the ancestry of
the serving production revision; a green PR check does not establish CI for its merge commit.
