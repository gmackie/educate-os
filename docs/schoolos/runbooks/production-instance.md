# Runbook: the schoolos.gmac.io production instance

- Issue: SCHO-192.
- Instance: <https://schoolos.gmac.io>, one long-lived SchoolOS deployment on the gmacko Cloudflare
  account (`c07a7e704db1808e1fff91bed2b1cd49`), deployed by ForgeGraph.
- Configs: `packages/<worker>/wrangler.production.jsonc`, generated and committed.
- Generator: `scripts/production/production-config.ts`. The instance's values are in
  `scripts/production/schoolos-gmac-io.ts`. The guard's configuration is the `AI_GUARD_CONFIG`
  secret, whose public example is `deploy/schoolos-gmac-io/ai-guard-config.example.json`.

The instance is synthetic. Its AI call guard serves a demo district with a single staff principal,
and legal review (SCHO-118) must pass before any real student uses it.

## The six Workers

Every Worker is named after its package, has `workers_dev` and `preview_urls` off, and is reached
only through the router. The router is the only Worker with a hostname: the custom domain
`schoolos.gmac.io`.

| Worker | Config | Binds |
|---|---|---|
| `router` | `packages/router/wrangler.production.jsonc` | `WORKSHOP_BACKEND`, `GATEKEEPER_{CONTEXT,SCHEDULER,WEBSEARCH}`, and the Access-mode frontend as `ASSETS` |
| `workshop-backend` | `packages/workshop-backend/wrangler.production.jsonc` | The three gatekeepers' `GatekeeperVendor` entrypoints (context gets `props.sharingDomain` = the origin), `AI_CALL_GUARD` → `schoolos-ai-guard#SchoolOsAiCallGuard`, `WORKERS_AI`, KV `BLUEPRINTS` and `AVATARS`, R2 `BLUEPRINT_CONTENT` (`schoolos-prod-blueprint-content`), `BROWSER`, `LOADER` |
| `gatekeeper-context` | `packages/gatekeeper-context/wrangler.production.jsonc` | KV `CONTEXT_COLLECTIONS` |
| `gatekeeper-scheduler` | `packages/gatekeeper-scheduler/wrangler.production.jsonc` | none |
| `gatekeeper-websearch` | `packages/gatekeeper-websearch/wrangler.production.jsonc` | `AI`, with `CF_AI_GATEWAY=default` |
| `schoolos-ai-guard` | `packages/schoolos-ai-guard/wrangler.production.jsonc` | `HALL_MONITOR` → `hall-monitor` (already in the account). It runs its production entrypoint `src/worker.ts` with the nightly `17 3 * * *` reconciliation cron. |

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

The guard is its own ForgeGraph app because ForgeGraph's `syncSecrets` copies every secret of a
stage onto each target that sets it: in one app, the backend would also receive the guard's signing
key. `AI_GUARD_CONFIG` is a secret rather than a var because it names the admin's Workshop user,
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
