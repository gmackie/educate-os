# Bringing up the hosted admin at admin.educateos.io

- Issue: SCHO-263 (phase 5 of SCHO-257). Design: [admin.md](../admin.md). The control plane it takes
  over from: [control-plane.md](../control-plane.md#moving-to-the-admin-scho-263).
- Code: `packages/educateos-admin` (Worker + D1 + SPA), its production config
  `packages/educateos-admin/wrangler.production.jsonc`, and the import command
  `scripts/educateos-admin-import.ts`.
- Account: the EducateOS Cloudflare account (`c07a7e70…`). It holds the educateos.io zone, the
  `educateos-site` Worker and the Access team `gmacko`.

None of this happens automatically. The production config is written by hand, and only the ForgeGraph
app `educateos-admin` deploys it. These steps create that app. Release discovery, the worker config
generator, the staging, preview and production generators, the dev server and the primary app
`educate-os` all ignore the config (`scripts/educateos-admin-config.test.ts` checks this). Until
step 6, a deploy would fail anyway, because Cloudflare refuses the placeholder D1 database ID.

Do the steps in order. Each step says how to check it.

## 0. Prerequisites

- The PR that adds this runbook is merged, and `educateos-site` has deployed it. From then on, the
  site Worker exports the `ControlPlaneExporter` entrypoint that the admin's `CONTROL_PLANE` service
  binding names. A deploy is refused if a service binding names an entrypoint that doesn't exist.
  Check: for app `educateos-site`, `forge deploy history --stage production --json` (run from a
  scratch directory, as in step 5) shows the merge commit active.
- Wrangler is signed in to the EducateOS account: `pnpm exec wrangler whoami`.
- An API token for the Access calls in step 2, with **Access: Apps and Policies: Edit** on the account.
  Keep it out of shell history:

  ```sh
  export CF_ACCOUNT_ID=<the EducateOS account ID, c07a7e70…>
  read -rs CF_API_TOKEN && export CF_API_TOKEN
  ```

## 1. The D1 database

Run these from a checkout of main, in the package directory:

```sh
cd packages/educateos-admin
pnpm exec wrangler d1 create educateos-admin
```

Copy the `database_id` it prints into `wrangler.production.jsonc` in place of `REPLACE_AT_PROVISION`
(the comment next to it names this step). Then apply the migrations to the new, empty database:

```sh
pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.production.jsonc
pnpm exec wrangler d1 execute DB --remote -c wrangler.production.jsonc \
  --command "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
```

Check: the tables are `analytics_snapshots`, `audit_log`, `d1_migrations`, `installations`,
`operators`, `ops_keys`, `slug_reservations` and `workspaces`. `d1_migrations` lists
`0001_initial.sql` and `0002_control_plane.sql`.

## 2. The Access application

Follow the operator console's pattern. The Access application **EducateOS operator console**
(`9074c7b7-1276-4135-a204-277b08a89567`) signs people in with one-time PIN and GitHub. Read its
sign-in methods:

```sh
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps/9074c7b7-1276-4135-a204-277b08a89567" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq '.result | {allowed_idps, session_duration}'
```

Create **EducateOS admin** for `admin.educateos.io` with the same `allowed_idps`. The console's policy
admits anyone with an email address. This one admits only the operators, so list the same people as
`ADMINS` (step 3). The Worker checks `ADMINS` again on every request: Access is the first gate, not
the only one.

```sh
IDPS='["<idp id>", "<idp id>"]'   # the allowed_idps printed above: one-time PIN and GitHub
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data @- <<JSON | jq '.result | {id, aud}'
{
  "name": "EducateOS admin",
  "type": "self_hosted",
  "domain": "admin.educateos.io",
  "destinations": [{ "type": "public", "uri": "admin.educateos.io" }],
  "allowed_idps": $IDPS,
  "auto_redirect_to_identity": false,
  "app_launcher_visible": false,
  "session_duration": "24h",
  "policies": [{
    "name": "EducateOS operators",
    "decision": "allow",
    "include": [{ "email": { "email": "mackieg@gmacko.com" } }]
  }]
}
JSON
```

Add one `include` entry per operator. Put the `aud` that the call prints into
`wrangler.production.jsonc` in place of `REPLACE_AT_PROVISION_ACCESS_AUD`. Commit both placeholder
values in one PR ("SCHO-263: provision admin.educateos.io"). `ACCESS_ISSUER` is already set to the
team, `https://gmacko.cloudflareaccess.com`.

**The health check needs a bypass.** ForgeGraph probes `https://admin.educateos.io/healthz` without
signing in. Give that one path its own application with a bypass policy. In Access, the more specific
path wins.

```sh
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{
    "name": "EducateOS admin health check",
    "type": "self_hosted",
    "domain": "admin.educateos.io/healthz",
    "destinations": [{ "type": "public", "uri": "admin.educateos.io/healthz" }],
    "app_launcher_visible": false,
    "policies": [{ "name": "Health check", "decision": "bypass", "include": [{ "everyone": {} }] }]
  }' | jq '.result | {id}'
```

`/healthz` returns only `{"status","edition","commit"}`, and only once D1 answers.

Check: once the Worker is deployed (step 6), `curl -sI https://admin.educateos.io/` answers a 302 to
`gmacko.cloudflareaccess.com`. Before that, the hostname serves nothing.

## 3. Secrets

There are two secrets. Neither ever goes in a config:

- `ADMIN_KEY_ENCRYPTION_KEY`: 32 random bytes, base64url. It seals every workspace's ops private key
  in D1. **If it is lost, every sealed key is unreadable**, and each workspace has to be enrolled and
  registered at its district again. Keep a copy in the owner's Keychain.
- `ADMINS`: the operators, as comma-separated email addresses or Access subjects. Append `:viewer`
  for read-only access. An empty list admits nobody.

```sh
KEK=$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=')
security add-generic-password -a educateos -s educateos-admin-key-encryption-key -w "$KEK"
```

Step 5 stores them in ForgeGraph, which syncs them onto the Worker on every deploy. Step 6 also sets
them directly on the Worker, so they are there before the first request.

## 4. Why a separate ForgeGraph app

`educateos-admin` is its own ForgeGraph app on this repository, like `educateos-site`,
`educateos-ai-guard` and `educateos-google`:

- `syncSecrets` copies every secret of a stage onto each target that sets it. In the primary app
  `educate-os`, the backend would receive the admin's key-encryption key, and the admin would receive
  the backend's Access audience.
- A failing admin deploy must not hold back `production.healthy` for `educate-os`, which credits
  district PRs in Kanbanger. As with the site, Kanbanger receipts come only from `educate-os`, so
  record the `educateos-admin` deployment ID and health on the issue by hand.

The app's configuration lives in ForgeGraph. It is not in the repository's `.forgegraph.yaml`, which
belongs to the primary app (`scripts/educateos-admin-config.test.ts` fails if it names the admin).

## 5. The ForgeGraph app, stage and target

```sh
forge app create educateos-admin --no-repo --flake-ref git+https://git.forgegraf.com/gmackie/educate-os
forge app link-repo --app educateos-admin --repo gmackie/educate-os
```

`forge stage add` has no `--app` flag. It finds the app from the `.forgegraph.yaml` in the current
directory. Run it, and every later per-app command, from a scratch directory that names the app:

```sh
mkdir -p /tmp/fg-educateos-admin && cd /tmp/fg-educateos-admin
cat > .forgegraph.yaml <<'YAML'
# Scratch config for the educateos-admin ForgeGraph app (SCHO-263). Not committed anywhere.
app: educateos-admin
server: https://forgegraf.com
YAML
forge stage add production
```

The target goes on hetzner-fg, like the other Workers. The key names matter:

- `appDir`: without it, the agent guesses one Wrangler directory for the whole repository.
- `deployCommand`: an unknown key such as `deploy` is silently ignored, and a bare `wrangler deploy`
  runs instead.
- `buildCommand`: the package has no `build` script, so the default `pnpm build` fails.
- `healthCheckUrl`: set it on the target. Without it, Kanbanger refuses delivery receipts.
- `syncSecrets`: copies the stage's secrets onto the Worker after each deploy.

```sh
forge target add educateos-admin --app educateos-admin --stage production --platform cloudflare-workers \
  --node bf11e7b1-b9de-45be-a89d-ae08049c7598 --config '{
    "workerName": "educateos-admin",
    "appDir": "packages/educateos-admin",
    "configPath": "packages/educateos-admin/wrangler.production.jsonc",
    "buildCommand": "node ../../scripts/production/stamp-commit.ts wrangler.production.jsonc && pnpm exec vp run --no-cache -F @educateos/admin build",
    "deployCommand": "pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.production.jsonc && pnpm exec wrangler deploy -c wrangler.production.jsonc",
    "healthCheckUrl": "https://admin.educateos.io/healthz",
    "syncSecrets": true
  }'
```

- `stamp-commit.ts` writes `FG_COMMIT_HASH` into the config passed with `-c`. The agent doesn't stamp
  that config itself (FORGE-212), and without the hash the source-order guard refuses every later
  deploy.
- The build runs the package's typechecks, then the SPA's Vite build into `dist/`, which the assets
  binding serves.
- The deploy applies any new D1 migration before the new code goes live. So the deploy token needs
  **D1: Edit** as well as **Workers Scripts: Edit**. Wrangler doesn't prompt when there is no
  terminal.

Then set the secrets, from the scratch directory:

```sh
security find-generic-password -s educateos-admin-key-encryption-key -w | forge secret set ADMIN_KEY_ENCRYPTION_KEY --stage production --stdin
forge secret set ADMINS 'mackieg@gmacko.com' --stage production
forge secret list --stage production
```

Check: `forge secret list --stage production` lists exactly those two names.

## 6. The first deploy

Once the provisioning PR from step 2 is merged, deploy that commit:

```sh
cd /tmp/fg-educateos-admin
forge deploy create production --target educateos-admin --ref <full SHA of the provisioning merge>
forge deploy history --stage production --json | jq '.[0] | {id, status, versionId}'
```

ForgeGraph's `syncSecrets` puts the secrets on the Worker after the deploy. In case the first request
arrives before that, also set them directly, from the package directory:

```sh
cd packages/educateos-admin
security find-generic-password -s educateos-admin-key-encryption-key -w | pnpm exec wrangler secret put ADMIN_KEY_ENCRYPTION_KEY -c wrangler.production.jsonc
printf 'mackieg@gmacko.com' | pnpm exec wrangler secret put ADMINS -c wrangler.production.jsonc
```

Check:

- `curl -s https://admin.educateos.io/healthz` answers `{"status":"ok","edition":"hosted","commit":"<the SHA>"}`.
- `curl -sI https://admin.educateos.io/api/me` answers a 302 to Access, not a 200. The bypass covers
  only `/healthz`.
- Once you are signed in, `https://admin.educateos.io/` shows the Workspaces page. It has an
  **Install a new workspace** link (to `https://educateos.io/app/install`) and an empty
  **Installed through educateos.io** section.
- `pnpm exec wrangler versions view <versionId> --name educateos-admin --json` shows
  `env.FG_COMMIT_HASH` and the `CONTROL_PLANE` service binding.

## 7. The import

The admin reads educateos.io's operators, installations and slug reservations through its
`CONTROL_PLANE` binding and writes them to D1. The binding points at the site Worker's read-only
`ControlPlaneExporter`, which has no URL. The import is idempotent: it writes only what differs, so a
second run with nothing new changes nothing. Do a dry run first:

```sh
cloudflared access login https://admin.educateos.io
node scripts/educateos-admin-import.ts --dry-run
node scripts/educateos-admin-import.ts
node scripts/educateos-admin-import.ts --dry-run   # again: every count is "unchanged", nothing removed
```

The Workspaces page does the same thing. **Check educateos.io for new installations** runs the dry
run and shows the counts, and **Import** applies it. Either way, the run is audited as
`control-plane.import`.

What the import does:

- **Operators.** Each one comes in with the role `installer`. The exception is an operator who has
  already signed in here: they keep their email and role, and gain their control-plane account ID.
  `ADMINS` still decides who may use the admin.
- **Installations.** Each one maps onto a workspace at `https://<slug>.educateos.io`. If a workspace
  with the same slug and origin exists, the installation is matched to it. Otherwise the import makes
  a pending, self-hosted workspace with its own ops key, named after the slug until someone renames
  it. If another workspace already has the slug or the origin, the installation is left unmapped and
  reported under `skipped`.
- **Slug reservations.** These are mirrored. educateos.io's Durable Object stays authoritative for
  them, because the guided install, Clever launches and the registry still run there.
- **No district data.** Nothing about a district's people is read or written. The control plane never
  held any.

Check: `GET https://admin.educateos.io/api/installations` (or the Workspaces page) lists the
installations, and a dry run after the import reports nothing to create or change.

## 8. Moving educateos.io/app to the admin

Set `ADMIN_URL` on the site Worker, in a PR that edits `sites/educateos-io/wrangler.jsonc`:

```jsonc
"vars": {
  // ...
  "ADMIN_URL": "https://admin.educateos.io/"
}
```

The same PR changes the `ADMIN_URL` assertion in `sites/educateos-io/site-config.test.mjs` from
`undefined` to that URL. It is a var in the config rather than a dashboard setting because every
ForgeGraph deploy of the site replaces the Worker's vars with the config's.

Once it is deployed:

- `/app`, `/app/` and every other `/app/*` path answer `302 Location: https://admin.educateos.io/`.
  It is a 302, not a 308, so removing the var undoes the move.
- `/app/install` stays on educateos.io. The guided install runs inside the site Worker, next to the
  release bucket and the slug reservations. Its "back to your installations" links now land on the
  admin.
- `/clever/launch`, `/registry/v1/*`, `/healthz` and the static site don't change.

To check, sign in to the operator console first. Access still covers `/app/*`, so a bare curl gets the
Access sign-in redirect before it reaches the Worker:

```sh
cloudflared access login https://educateos.io/app/
cloudflared access curl https://educateos.io/app/ -sI | grep -i '^location'      # https://admin.educateos.io/
cloudflared access curl https://educateos.io/app/install -s -o /dev/null -w '%{http_code}\n'   # 200
curl -s https://educateos.io/healthz
```

Optionally, narrow the operator console's Access application to `educateos.io/app/install` only.
Then the redirect no longer asks for a sign-in first. The Worker still checks the assertion on the
install page itself, and the redirect discloses nothing.

## After the move

- **New guided installs** still record into educateos.io's Durable Object. To bring them into the
  admin, run the import again (step 7). A later change can have the guided install notify the admin
  directly.
- **Rollback:** revert the `ADMIN_URL` PR. At the next deploy the console is back on educateos.io,
  with every installation it ever had, because the import only reads from it.
- **Record on SCHO-263:** the `educateos-admin` and `educateos-site` deployment IDs, the commit, the
  `/healthz` answer, the import's report, and the redirect check.
