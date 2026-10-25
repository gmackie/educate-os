# Runbook: the schoolos.gmac.io production instance

- Issues: SCHO-192 (the instance), SCHO-193 (the LMS-lite district).
- Instance: <https://schoolos.gmac.io>, one long-lived SchoolOS deployment on the gmacko Cloudflare
  account (`c07a7e704db1808e1fff91bed2b1cd49`), deployed by ForgeGraph.
- Configs: `packages/<worker>/wrangler.production.jsonc`, generated and committed.
- Generator: `scripts/production/production-config.ts`. The instance's values are in
  `scripts/production/schoolos-gmac-io.ts`. The guard's configuration is the `AI_GUARD_CONFIG`
  secret, whose public example is `deploy/schoolos-gmac-io/ai-guard-config.example.json`.

The instance is synthetic. Its AI call guard serves a demo district with a single staff principal,
and legal review (SCHO-118) must pass before any real student uses it.

## The Workers

Every Worker is named after its package and has `workers_dev` and `preview_urls` off. Two have a
hostname, each a custom domain behind its own Access application: the router at `schoolos.gmac.io`,
and the district Worker at `district.schoolos.gmac.io` (see [The district](#the-district-lms-lite)).
Every other Worker is reached only through the router.

| Worker | Config | Binds |
|---|---|---|
| `router` | `packages/router/wrangler.production.jsonc` | `WORKSHOP_BACKEND`, `GATEKEEPER_{CONTEXT,SCHEDULER,WEBSEARCH}`, and the Access-mode frontend as `ASSETS` |
| `workshop-backend` | `packages/workshop-backend/wrangler.production.jsonc` | The three gatekeepers' `GatekeeperVendor` entrypoints (context gets `props.sharingDomain` = the origin), `AI_CALL_GUARD` → `schoolos-ai-guard#SchoolOsAiCallGuard`, `WORKERS_AI`, KV `BLUEPRINTS` and `AVATARS`, R2 `BLUEPRINT_CONTENT` (`schoolos-prod-blueprint-content`), `BROWSER`, `LOADER` |
| `gatekeeper-context` | `packages/gatekeeper-context/wrangler.production.jsonc` | KV `CONTEXT_COLLECTIONS` |
| `gatekeeper-scheduler` | `packages/gatekeeper-scheduler/wrangler.production.jsonc` | none |
| `gatekeeper-websearch` | `packages/gatekeeper-websearch/wrangler.production.jsonc` | `AI`, with `CF_AI_GATEWAY=default` |
| `schoolos-ai-guard` | `packages/schoolos-ai-guard/wrangler.production.jsonc` | `HALL_MONITOR` → `hall-monitor` (already in the account). It runs its production entrypoint `src/worker.ts` with the nightly `17 3 * * *` reconciliation cron. |
| `schoolos-district-worker` | `packages/schoolos-district-worker/wrangler.production.jsonc` | `SEND_EMAIL` (Email Service), the district's UIs as static assets, and its two Cron Triggers. Its Durable Object needs no binding. |

The backend's vars are `PUBLIC_BASE_URL`, plus `CF_AI_GATEWAY=default`, `CF_AI_GATEWAY_ACCOUNT_ID`
and `CF_AI_GATEWAY_PROVIDERS=cloudflare`. With these, Workers AI is server-managed through the
account's default gateway, over the `WORKERS_AI` binding, so no API token is needed. Each gatekeeper
gets `BASE_URL=https://schoolos.gmac.io/gatekeeper/<short>`.

The guard reaches Hall Monitor by service binding, which it prefers over `HALL_MONITOR_URL`, so that
var is not set. It signs its service tokens as `iss=schoolos`, `aud=hall-monitor`, for tenant
`schoolos-gmacko-demo`. Hall Monitor (hall-monitor.gmac.io, HM-12) trusts that issuer with the
public half of the signing key (`kid` `schoolos-1`). The guard config names Hall Monitor's built-in
profiles at revision `builtin-1`: `educator`, `student-9-12`, and `student-6-8` for both the 6-8 and
K-5 audience classes (Hall Monitor has no younger profile and moderates younger bands under the
stricter 6-8 one). The guard's optional AI Gateway log reader (`AI_GATEWAY_ACCOUNT_ID`,
`AI_GATEWAY_ID`, `AI_GATEWAY_LOGS_TOKEN`) is left unset, so settlements are estimated, and the nightly
reconciliation only records snapshots.

## Secrets (delivered by ForgeGraph, never in a config)

| Worker | Secret | ForgeGraph app |
|---|---|---|
| `workshop-backend` | `ADMINS` (a JSON array of Access emails), `CF_ACCESS_AUD`, `CF_ACCESS_ISS` | `school-os` |
| `schoolos-ai-guard` | `HALL_MONITOR_SIGNING_KEY` (private Ed25519 or P-256 JWK, with a `kid`), `AI_GUARD_CONFIG` (the example config with the admin's Access email in place of `admin@example.com`, minified) | `schoolos-ai-guard` |
| `schoolos-district-worker` | `DISTRICT_CONFIG` (the demo district's seed, minified), `CF_ACCESS_AUD` (the district Access application's audience), `CF_ACCESS_ISS` | `schoolos-district` |

The guard and the district are each their own ForgeGraph app because ForgeGraph's `syncSecrets`
copies every secret of a stage onto each target that sets it: in one app, the backend would also
receive the guard's signing key, and the district would receive the backend's Access audience in
place of its own. `AI_GUARD_CONFIG` is a secret rather than a var because it names the admin's Workshop user,
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
| `packages/schoolos-ai-guard` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc` (Wrangler's own build runs capnweb-validate) | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/workshop-backend` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache -F @gadgets/typed-storage build && pnpm exec vp run --no-cache build:bundled-blueprints` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/schoolos-district-worker` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && VITE_CF_ACCESS_MODE=true pnpm exec vp run --no-cache -F @schoolos/student-ui build && SCHOOLOS_UI_BASE=/admin/ pnpm exec vp run --no-cache -F @schoolos/admin-ui build && SCHOOLOS_UI_BASE=/teach/ pnpm exec vp run --no-cache -F @schoolos/teacher-ui build && node ../../scripts/production/assemble-district-ui.ts` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |
| `packages/router` | `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && VITE_CF_ACCESS_MODE=true pnpm exec vp run --no-cache -F @gadgets/workshop-frontend build` | `pnpm exec wrangler deploy -c wrangler.production.jsonc` |

`VITE_CF_ACCESS_MODE=true` is a build-time flag. Without it, the frontend serves a password form
that the backend rejects. The release build sets it the same way (`build-release.ts`).

### Cold bring-up order

A service binding needs its target to exist, so deploy in tiers:

1. `gatekeeper-context`, `gatekeeper-scheduler`, `gatekeeper-websearch` and `schoolos-ai-guard`.
   They can go in parallel. `hall-monitor` must already exist.
2. `workshop-backend`, after setting its secrets.
3. `router`, which creates the `schoolos.gmac.io` custom domain. The `gmac.io` zone must be on the
   account.

The district Worker binds no other Worker and nothing binds it, so it can go at any point.

Later deploys can go in any order, as long as no binding is renamed.

### Bindings the account must support

The backend declares `LOADER` (Worker Loader, the gadget sandbox) and `BROWSER` (Browser Rendering,
for gadget PDF export), as in its repository config. If the account lacks either, the backend
deploy fails. Enable the product rather than editing the generated config.

## Changing the instance

1. Edit `scripts/production/schoolos-gmac-io.ts` (resources, vars, gatekeepers). For the guard
   config, edit `deploy/schoolos-gmac-io/ai-guard-config.example.json`, then set the deployed copy
   with the admin's email substituted:
   `forge secret set AI_GUARD_CONFIG --stage production --stdin` for app `schoolos-ai-guard`. A Worker's own bindings change in its
   `cloudflare.config.ts`, as usual (`pnpm configs:generate` first).
2. Run `pnpm production:configs` and commit the regenerated `wrangler.production.jsonc` files.
   `pnpm production:check`, which is part of `pnpm lint`, fails on drift. The generator fails
   closed in three cases: a Worker declares a KV or R2 binding the instance names no resource for,
   the instance names one the Worker does not declare, or a var has a secret's name.
3. The guard config must stay under 5 KB, the limit for one Workers secret. It must also parse with
   `readGuardConfig`. `packages/schoolos-ai-guard/__tests__/demo-config.test.ts` checks both, and
   checks that every suggested Workers AI model is priced.
4. Check each config with
   `pnpm exec wrangler deploy -c wrangler.production.jsonc --dry-run --outdir <tmp>`, run from the
   package directory after its `buildCommand`.

## The district (LMS-lite)

SCHO-193 adds the LMS-lite district application: `schoolos-district-worker`, for the demo co-op,
at `https://district.schoolos.gmac.io`. The router sends `/api/*` to the Workshop backend, so the
district has its own hostname, behind its own Access application.

- **What it serves.** The Worker runs first for `/api/*` (the district's API, verified against its
  own Access audience) and `/healthz` (a liveness probe that reads nothing). Everything else is
  static assets, laid out at deploy time by `scripts/production/assemble-district-ui.ts`. The student
  Learning Home, path-routed, is at `/` with the single-page fallback. The admin console is at
  `/admin/` and Teacher Studio at `/teach/`. Both route by hash and are built with
  `SCHOOLOS_UI_BASE` set to their prefix. The student build sets `VITE_CF_ACCESS_MODE=true`, so it
  takes no development `?token=`: Access signs its requests. Guardians use the student app's family
  view.
- **State.** One SQLite Durable Object holds the district (see the package README), so a deploy
  never touches its data.
- **Access.** The application `SchoolOS district (demo co-op)` covers the hostname, with a bypass
  application for `district.schoolos.gmac.io/healthz`. Its audience is the district's
  `CF_ACCESS_AUD`. The issuer is the same team domain as the instance's.
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
  `forge secret set DISTRICT_CONFIG --stage production --stdin` for app `schoolos-district`.
  `__tests__/demo-config.test.ts` in the package checks that the example parses and fits in a
  secret. The seed is read only on the object's first start.
- **Not bound yet.** The guard keeps its configured directory: binding its `SCHOOLOS_DISTRICT` to
  `DistrictGuardDirectory` would resolve Workshop users through the district's identity links, which
  the instance's admin does not have (SCHO-147). The backend's `SCHOOLOS_DISTRICT_API` is left out
  too, since nothing routes to it.
- **Email.** `DISTRICT_CONFIG.email.from` must be on a domain onboarded to Cloudflare Email Service
  in the account. Without `email`, notifications stay in-app and the digest is not mailed.
- **ForgeGraph.** App `schoolos-district`, stage `production`, one `cloudflare-workers` target
  `schoolos-district-worker` on hetzner-fg: `appDir` `packages/schoolos-district-worker`,
  `configPath` `packages/schoolos-district-worker/wrangler.production.jsonc`, the `buildCommand`
  and `deployCommand` in the table above, `syncSecrets: true`, and `healthCheckUrl`
  `https://district.schoolos.gmac.io/healthz`.
