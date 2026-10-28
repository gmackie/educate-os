# Runbook: the one-origin cutover (Northfield and the demo districts)

- Issues: SCHO-259 (phase 1 of epic SCHO-257). Decision: [ADR-0014](../adr/0014-one-origin-per-district.md).
- Before: the router serves the Workshop at `schoolos.gmac.io`, and `schoolos-district-worker` serves
  the LMS at `district.schoolos.gmac.io` and `northfield.educateos.io`, each host behind its own
  Access application.
- After: the router serves `northfield.educateos.io`, with the LMS at `/` (through its `DISTRICT`
  binding) and the Workshop at `/ai`. One Access application covers the host, and a bypass
  application covers the paths that check their own credential. `schoolos.gmac.io/*` redirects to
  `northfield.educateos.io/ai/*`, and `district.schoolos.gmac.io/*` to `northfield.educateos.io/*`.
- Switches: `oneOrigin` and `principalBinding` in `scripts/production/schoolos-gmac-io.ts`,
  `DEMO_DISTRICTS_ONE_ORIGIN` in `scripts/production/demo-districts.ts`, and the router's
  `buildCommand` in `.forgegraph.yaml`. On `main` they are all off, and the generated configs are
  byte-identical to the ones from before the switches existed (`production-config.test.ts` checks this).

Merging to `main` deploys production. Each switch below therefore lands in its own PR, merged only
when the step before it has been verified.

## What the switches generate

With `oneOrigin.enabled: true` (`pnpm production:configs`):

| Worker | Change |
|---|---|
| `router` | Custom domains `northfield.educateos.io`, `schoolos.gmac.io` and `district.schoolos.gmac.io`. `DISTRICT` → `schoolos-district-worker`. Assets `run_worker_first: true`. `LEGACY_HOSTS` = `{"schoolos.gmac.io":"https://northfield.educateos.io/ai","district.schoolos.gmac.io":"https://northfield.educateos.io"}`. `AI_ENABLED` stays unset. |
| `workshop-backend` | `PUBLIC_BASE_URL=https://northfield.educateos.io`, `PUBLIC_BASE_PATH=/ai`. Its gatekeeper-context `sharingDomain` follows the origin. |
| gatekeepers | `BASE_URL=https://northfield.educateos.io/gatekeeper/<name>`. The EducateOS connector's `DISTRICT_URL` becomes the origin. |
| `schoolos-district-worker` | No custom domains (the router reaches it by service binding). Same name, assets and crons. `SCHOOL_MANIFEST={"origin":"https://northfield.educateos.io","features":{"ai":true}}`. `LTI_TOOL_ORIGIN` stays `https://district.schoolos.gmac.io`, the origin the LMS platforms registered. |

Build env isn't part of a Wrangler config. The router's frontend must be built for `/ai`
(`productionBuildEnv` in `production-config.ts` returns `VITE_WORKSHOP_BASE_PATH=/ai/`), so the
flip PR also edits the router's `buildCommand` in `.forgegraph.yaml`.

`principalBinding: "migration"` adds `PRINCIPAL_MIGRATION` to the backend, and `"resolver"` adds
`PRINCIPAL_RESOLVER` as well. Both point at `schoolos-district-worker#DistrictPrincipalResolver`.

With `DEMO_DISTRICTS_ONE_ORIGIN = true`, each demo district's Worker runs first for `/ai` and
`/ai/*` and answers with the "AI isn't enabled at your school" page
(`packages/educateos-district-worker/src/ai-disabled.ts`), linking to
`AI_DEMO_URL=https://northfield.educateos.io/ai/`. It also publishes `SCHOOL_MANIFEST` with its
origin and `features.ai: false`. Nothing else changes, including its hostname and name.

## Access model

One application per host, plus one bypass application (ADR-0014 decision 4). Access uses the
most specific matching path.

| Application | Destinations | Policy |
|---|---|---|
| The instance's application (its audience is `workshop-backend`'s `CF_ACCESS_AUD`) | `northfield.educateos.io`; `northfield.educateos.io/api/pair/rooms`, `/api/pair/rooms/*/status`, `/api/pair/rooms/*/approve`, `/api/pair/rooms/*/deny` | its current allow policies |
| `EducateOS Northfield (bypass)` (new) | `northfield.educateos.io` + `/healthz`, `/.well-known/educateos.json`, `/lti/*`, `/api/m/*`, `/api/pair/*`, `/api/ops/*` | bypass, everyone |
| `EducateOS legacy hostnames (bypass)` (new, in step 6) | `schoolos.gmac.io`, `district.schoolos.gmac.io` | bypass, everyone |

Why `/api/pair/*` is bypassed while four paths under it are listed on the main application: the
phone's pairing endpoints (`POST /api/pair/self-rooms`, `POST /api/pair/rooms/<room>/claim`, and the
poll `GET /api/pair/rooms/<room>`) carry no Access session and are authenticated by the room secret.
The browser endpoints (create, status, approve, deny) belong to a signed-in web session, and the
district checks them against the Access assertion. Access adds that assertion only on a path its
application covers, so those four are listed, more specifically, on the main application, with the
same audience. If Access ever matched the bypass for one of them instead, no assertion would reach
the district and it would answer 401. This fails closed. Access can't tell the poll `GET` from
`/status` by method, which is why the bypass is the prefix and the exceptions are listed paths. The
installer models the same split (`ACCESS_BYPASS_PATHS` and `ACCESS_PAIRING_BROWSER_PATHS` in
`packages/educateos-installer/src/desired.ts`).

Every route under a bypass path checks its own credential: the probe and the manifest carry nothing
private, LTI verifies the platform's signed launch, `/api/m/*` checks a device token, `/api/pair/*`
a room secret, and `/api/ops/*` an Ed25519 signature. The legacy hostnames can be bypassed whole
because the router answers there only with `/healthz` and redirects (`LEGACY_HOSTS` is checked
before anything is routed).

Access API, for every application edit below: read the application, change `destinations` (and
`domain`, the primary destination), then write the full body back.

```sh
ACCT=c07a7e704db1808e1fff91bed2b1cd49
api() { local p=$1; shift; curl -sS -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' "https://api.cloudflare.com/client/v4/accounts/$ACCT$p" "$@"; }
api /access/apps | jq -r '.result[] | [.id, .name, .aud, ([.destinations[]?.uri] | join(" "))] | @tsv'
api /access/apps/$APP | jq .result > app.json          # edit into new.json, then:
api /access/apps/$APP -X PUT --data @new.json | jq '.success, .result.destinations'
```

## Cutover

### 0. Preconditions

- On `main` and deployed: #184 (router path table), #186 (device API), #187 (Workshop base path),
  #189 (`PRINCIPAL_RESOLVER` and `PRINCIPAL_MIGRATION`, `scripts/principal-migration.ts`), this
  change, and the pairing relay (`/api/pair/*`) if phones should pair on the new origin.
- `schoolos-district-worker` is on a release that exports `DistrictPrincipalResolver`.
- Write down both Access audiences (the instance's and the district's) and the current destinations
  of every application that names `schoolos.gmac.io`, `district.schoolos.gmac.io` or
  `northfield.educateos.io`. The rollback restores these.

### 1. Device token key

```sh
openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n' | \
  FG_APP=educateos-district forge secret set DEVICE_TOKEN_SECRET --stage production --stdin
forge deploy create production --target <the district target of app educateos-district>
```

Without the key, `/api/m/*` answers 503. With it, it answers 401 to a request with no device
credential. Step 4 checks this.

### 2. OAuth redirect URIs

In the Google Cloud console, add `https://northfield.educateos.io/gatekeeper/google/oauth` to the
connector's OAuth client, keeping the `schoolos.gmac.io` one until the rollback window closes. Do the
same for any other gatekeeper with a registered redirect URI.

### 3. Principal migration (dry run, then apply)

On the old host, before anything moves. The steps are in
[production-instance.md](production-instance.md) (from #189); here they are flag flips.

1. PR: `principalBinding: "migration"` in `schoolos-gmac-io.ts`, then `pnpm production:configs`.
   Merge, and the backend deploys with `PRINCIPAL_MIGRATION`. Sign-in doesn't change.
2. Dry run, saved as the before-count:

   ```sh
   cloudflared access login https://schoolos.gmac.io
   CF_ACCESS_TOKEN=$(cloudflared access token --app https://schoolos.gmac.io) \
     node scripts/principal-migration.ts --workshop https://schoolos.gmac.io --dry-run --json > migration-before.json
   ```

   Check every `alias` mapping and the `ambiguous`, `cross-district` and `unmatched` counts. Resolve
   anything unexpected in the district's directory first.
3. Apply: the same command with `--apply` in place of `--dry-run`. Run it again: every entry is
   `already-aliased`, and `threadsViaPrincipal` equals `threads`.

`PRINCIPAL_RESOLVER` is bound in step 5, together with the flip, so sign-in moves to principals at
the moment the origin does.

### 4. Access on northfield.educateos.io

Make each change with the API calls above, back to back. Until step 6, `northfield.educateos.io`
is still served by the district Worker, which verifies the assertion on `/api/*` itself, so the
seconds between edits expose only the static UI.

1. Create a reusable policy `EducateOS one origin (bypass)`: decision `bypass`, include `everyone`.
2. Remove `northfield.educateos.io/healthz` from the district's `/healthz` bypass application, then
   create the application `EducateOS Northfield (bypass)`, self-hosted, with the six bypass paths
   on `northfield.educateos.io` and that policy.
3. Remove `northfield.educateos.io` from `EducateOS district (demo co-op)`, which keeps
   `district.schoolos.gmac.io`.
4. Add `northfield.educateos.io` and the four pairing browser paths to the instance's application,
   keeping `schoolos.gmac.io` as its `domain`. Its audience doesn't change: it is already the
   backend's `CF_ACCESS_AUD` and the second entry of the district's.

Check:

```sh
curl -s https://northfield.educateos.io/healthz                                                       # ok
curl -s https://northfield.educateos.io/.well-known/educateos.json | jq .name                         # the district's name
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://northfield.educateos.io/             # 302 …cloudflareaccess.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://northfield.educateos.io/api/pair/rooms       # 302 (Access)
curl -s -o /dev/null -w '%{http_code}\n' https://northfield.educateos.io/api/m/me                     # 401 (the Worker, not Access)
```

### 5. The flip PR

One PR, merged only after steps 1–4 are verified:

- `scripts/production/schoolos-gmac-io.ts`: `oneOrigin: { enabled: true, hostname: "northfield.educateos.io" }`
  and `principalBinding: "resolver"`.
- `pnpm production:configs`. The diff is the table under [What the switches generate](#what-the-switches-generate).
- `.forgegraph.yaml`: the router's `buildCommand` becomes
  `node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && VITE_CF_ACCESS_MODE=true VITE_WORKSHOP_BASE_PATH=/ai/ pnpm exec vp run --no-cache -F @gadgets/workshop-frontend build`,
  and the stage `url` becomes `https://northfield.educateos.io`. Health checks may stay on
  `https://schoolos.gmac.io/healthz`, which the router answers on the old host too, or move to the
  new one.
- `docs/educateos/runbooks/production-instance.md`: describe the new layout.

### 6. Deploy, in order

A custom domain belongs to one Worker. The router can't take `northfield.educateos.io` and
`district.schoolos.gmac.io` while `schoolos-district-worker` holds them, and the district's new
config, which lists no custom domain, doesn't release them. So release them by hand, immediately
before the router deploys. Those two hosts are down from this point until the router is deployed.

```sh
api /workers/domains | jq -r '.result[] | select(.service=="schoolos-district-worker") | [.id, .hostname] | @tsv'
api /workers/domains/<id> -X DELETE    # for district.schoolos.gmac.io, then northfield.educateos.io
```

Then merge the flip PR. If ForgeGraph's merge deploy doesn't follow this order, deploy target by
target with `forge deploy create production --target <name>`:

1. `schoolos-district-worker` (app `educateos-district`): `SCHOOL_MANIFEST`, no domains.
2. The gatekeepers (including `gatekeeper-google` in `educateos-google` and `gatekeeper-educateos` in
   `educateos-gatekeeper`), then the guard: new `BASE_URL`s.
3. `workshop-backend`: `PUBLIC_BASE_URL`, `PUBLIC_BASE_PATH`, `PRINCIPAL_RESOLVER`.
4. `router`: the `/ai` build, `DISTRICT`, the three domains and `LEGACY_HOSTS`.

When the first five checks under [Verify](#7-verify) pass, move the old hosts' Access. Remove
`schoolos.gmac.io` from the instance's application, whose `domain` becomes
`northfield.educateos.io`. Remove `district.schoolos.gmac.io` from `EducateOS district (demo co-op)`
and from its `/healthz` bypass. Then create `EducateOS legacy hostnames (bypass)` with destinations
`schoolos.gmac.io` and `district.schoolos.gmac.io` and the bypass policy. The district's
applications are now empty: delete them in step 9.

### 7. Verify

```sh
# The old hosts: redirects only, path and query kept, method kept for non-GET.
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' 'https://schoolos.gmac.io/blueprints?x=1'           # 301 https://northfield.educateos.io/ai/blueprints?x=1
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://district.schoolos.gmac.io/teach/            # 301 https://northfield.educateos.io/teach/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST https://district.schoolos.gmac.io/lti/launch # 308 https://northfield.educateos.io/lti/launch
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://schoolos.gmac.io/gatekeeper/google/oauth    # 301 https://northfield.educateos.io/gatekeeper/google/oauth
curl -s https://schoolos.gmac.io/healthz                                                                     # ok
# (Until the old hosts' Access moves, the first four answer 302 to Access for a signed-out curl;
# run them signed in, with -H "cf-access-token: $(cloudflared access token --app https://schoolos.gmac.io)".)

# The new origin, signed out.
curl -s https://northfield.educateos.io/healthz                                                              # ok
curl -s https://northfield.educateos.io/.well-known/educateos.json | jq '.origin, .features.ai'              # "https://northfield.educateos.io", true
for p in / /ai/ /api/me /api/pair/rooms/x/status; do curl -s -o /dev/null -w "$p %{http_code}\n" "https://northfield.educateos.io$p"; done   # all 302
curl -s -o /dev/null -w '%{http_code}\n' https://northfield.educateos.io/api/m/me                            # 401
curl -s -o /dev/null -w '%{http_code}\n' https://northfield.educateos.io/lti/jwks                            # 200

# Signed in.
cloudflared access login https://northfield.educateos.io
T=$(cloudflared access token --app https://northfield.educateos.io)
curl -s -H "cf-access-token: $T" https://northfield.educateos.io/api/me | jq .
curl -s -o /dev/null -w '%{http_code}\n' -H "cf-access-token: $T" https://northfield.educateos.io/ai/        # 200
CF_ACCESS_TOKEN=$T node scripts/principal-migration.ts --workshop https://northfield.educateos.io/ai --apply  # already-aliased only
```

In a browser: sign in once at `https://northfield.educateos.io/`, then open `/ai`. There's no second
sign-in, and a migrated user's threads are there. Connect a Google account in the Workshop: the
OAuth round trip lands on `northfield.educateos.io/gatekeeper/google/oauth`. Launch the LTI Tool
from Canvas and Moodle, where the launch goes through the 308. On the phone, sign in and open the
LMS tabs: no "Redirect is not allowed".

Record in SCHO-259: the PR, commit, each ForgeGraph deployment ID, the health checks and these
results.

### 8. Demo districts

After Northfield is verified, because their page links to it:

1. Access, for each of the five: add `/.well-known/educateos.json`, `/api/m/*`, `/api/pair/*` and
   `/api/ops/*` on `<slug>.educateos.io` to `EducateOS demo districts health (bypass)`, or create
   one bypass application with all six paths in place of the health and LTI bypasses. Add the four
   pairing browser paths to each district's own application. `/ai` stays behind the district's
   application.
2. Give each district a `DEVICE_TOKEN_SECRET` (step 1, with `FG_APP=educateos-<slug>`).
3. PR: `DEMO_DISTRICTS_ONE_ORIGIN = true`, then `pnpm production:configs` (only the five
   `wrangler.demo-<slug>.jsonc` change). Merge and deploy each `educateos-<slug>`.
4. Verify for each slug:

   ```sh
   curl -s https://<slug>.educateos.io/.well-known/educateos.json | jq '.origin, .features.ai'   # "https://<slug>.educateos.io", false
   T=$(cloudflared access token --app https://<slug>.educateos.io)
   curl -s -H "cf-access-token: $T" https://<slug>.educateos.io/ai | grep -o 'https://northfield.educateos.io/ai/'
   curl -s -o /dev/null -w '%{http_code}\n' -H "cf-access-token: $T" https://<slug>.educateos.io/ai/api/x   # 404
   ```

### 9. After one release

- Drop the district's dual audience: set its `CF_ACCESS_AUD` to the instance application's audience
  alone, deploy, and delete `EducateOS district (demo co-op)` and its `/healthz` bypass.
- Remove the router's legacy Workshop paths (`LEGACY_WORKSHOP_*` in `packages/router/src/one-origin.ts`).
- Re-register the LTI Tool at `https://northfield.educateos.io` on Canvas and Moodle, then move
  `LTI_TOOL_ORIGIN` (`asDistrict` in `production-config.ts`). Drop `district.schoolos.gmac.io`
  from `LEGACY_HOSTS` once nothing calls it.
- Remove the old Google redirect URI.

## Rollback

The redirects carry `cache-control: no-store`, so browsers don't keep them, and a rollback takes
effect at once.

1. PR: `oneOrigin.enabled: false`, and `principalBinding: "migration"`, which returns sign-in to
   email keys (the aliases are ignored while `PRINCIPAL_RESOLVER` is unbound). Then
   `pnpm production:configs`, and revert the router's `buildCommand` and the stage `url` in
   `.forgegraph.yaml`.
2. Access first, so nothing is served open: restore the destinations you wrote down in step 0. That
   means `schoolos.gmac.io` back as the instance application's `domain`, `northfield.educateos.io`
   (and its `/healthz`) back on the district's applications, `district.schoolos.gmac.io` back on
   them, and the two new bypass applications deleted.
3. Merge, then deploy the router first. Its config lists only `schoolos.gmac.io`, and Wrangler
   detaches the router's other custom domains. Then deploy the district, which takes back
   `district.schoolos.gmac.io` and `northfield.educateos.io`. If its deploy reports a conflict,
   detach the domain from the router with the API, as in step 6. Then the backend and the
   gatekeepers.
4. Verify as before the cutover: `https://schoolos.gmac.io/` serves the Workshop,
   `https://district.schoolos.gmac.io/healthz` answers `ok`, and the district's `/api/me` works signed in.

Phones paired on the new origin keep their device credentials, since `DEVICE_TOKEN_SECRET` isn't
removed. They reach `/api/m/*` again once the origin is back.

Demo districts: set `DEMO_DISTRICTS_ONE_ORIGIN = false`, regenerate and deploy. `/ai` returns to
the UI assets. The added bypass destinations are harmless and can stay.
