# Runbook: install EducateOS in a district's Cloudflare account

- Status: Draft. No district has run this yet. On 2026-11-18 the installer ran **into a clean
  Cloudflare account** that held nothing else (SCHO-378): `launch-educate-os` 0.3.0, release
  `r000004-15febba`, the district LMS included. The install took 124.9 s and the uninstall 22.9 s;
  the account was empty again afterwards. Durations below say which run they come from (see
  [Evidence](#evidence)). Human steps (subscriptions, DNS, identity provider) are estimates, not
  measurements.
- Issue: SCHO-363 (epic SCHO-358). Related: SCHO-378 (clean timed install), SCHO-241
  (second-account proof), SCHO-163 and SCHO-66 (installer fixes and permission probes), SCHO-439
  (school-service wizard support is prepared for 0.3.1; publication and a live wizard check remain
  pending, so use the answers file below with published 0.3.0).
- Audience: a district IT administrator with Super Administrator on the district's Cloudflare
  account. Public version: <https://educateos.io/it/install/>.
- Tool: [`npx launch-educate-os`](../launch-installer.md) ([package README](../../../packages/launch-educate-os/README.md)).

## What you end up with

EducateOS running in the district's own Cloudflare account, at a hostname on a domain the district
holds (by default `educateos.<your-domain>`), behind Cloudflare Access with the district's identity
provider. Every resource is named `educateos-<name>-*`. educateos.io serves the signed release
files and nothing else: it is never in the data path, holds no credential, and the install keeps
running if educateos.io is down.

The install creates (the 2026-11-18 clean install of a school release listed 18 creates):

| Kind | Count | Notes |
| --- | --- | --- |
| Workers | 7 | Router (public hostname), Workshop backend, three preinstalled gatekeepers (Context Library, Scheduled Tasks, Web Search), the district LMS Worker and the district MCP Worker. A school release requires the last two (see [Decisions](#decisions)). The OSS admin is optional and adds one. |
| KV namespaces | 3 | |
| R2 bucket | 1 | |
| D1 databases | 0 to 2 | Only with the OSS admin, with its migrations. |
| Access applications and policies | 2 each | One in front of the hostname, admitting the email domains and addresses you name; one bypass for `/healthz`, LTI, device and pairing paths. |
| Custom domain | 1 | Cloudflare creates the DNS record and certificate. |
| Worker secret and Cron Triggers | 1 each | The district Worker's `DEVICE_TOKEN_SECRET` (generated) and its two schedules. |
| AI Gateway | 0 or 1 | Optional. |

## Prerequisites checklist

Have all of these before you start. The installer's preflight checks every item marked
"preflight" and stops, having changed nothing, if one is missing.

| # | Item | Checked by | Typical lead time |
| --- | --- | --- | --- |
| 1 | A machine with **Node.js 22.12 or later** (`node --version`) | `doctor` | minutes |
| 2 | A **Cloudflare account** the district owns, with a payment method | preflight (`credential.rejected`, `permission.missing`) | minutes |
| 3 | **Workers Paid** on that account (from $5/month) | preflight (`plan.workers-paid-required`) | minutes |
| 3a | **A workers.dev subdomain**: open Workers & Pages in the dashboard once, which creates it | not checked; without it the first Worker upload fails with HTTP 403 code 10063 | 1 minute |
| 4 | **R2 enabled** (Cloudflare asks for a payment method; light use stays in the free tier) | preflight (`product.r2-not-enabled`; the API answers code 10042) | minutes |
| 5 | **Worker Loader** (dynamic Workers) available on the account | not checkable by API; preflight warns (`product.worker-loader`) | confirm with Cloudflare if unsure |
| 6 | **A domain as an active zone** in the account, with no DNS records yet at the hostname you'll use | preflight (`dns.zone-missing`, `dns.zone-pending`, `dns.record-conflict`) | minutes if already on Cloudflare; hours to a day if nameservers must move |
| 7 | **Cloudflare Zero Trust** with a team (`<team>.cloudflareaccess.com`) | preflight (`access.organization-missing`, `access.team-mismatch`) | minutes |
| 8 | **The district's identity provider** (SAML or OIDC: Google Workspace, Microsoft Entra ID, Clever, ...) added as a Zero Trust login method, besides one-time PIN | preflight (`access.idp-missing`) blocks only when every login method is one-time PIN. Turning Zero Trust on also adds Cloudflare's built-in login, which passes; that was enough for the SCHO-378 test, but a pilot needs the district IdP | depends on who administers the IdP |
| 9 | **Zero Trust seats**: Zero Trust Free admits 50 users, and every student and teacher who signs in takes a seat | preflight warns (`access.free-seat-limit`) | before the pilot opens, not before the install |
| 10 | **A scoped API token** with the 13 permissions below | `doctor`, preflight | 5 minutes |
| 11 | **AI Gateway**, which turns Workers AI on (free core features; Workers AI billed per use) | created by the installer unless you say no | none |
| 12 | **`DISTRICT_CONFIG` and `MCP_CONFIG`**: a school release requires the district LMS and district MCP services, each with its JSON (see [Decisions](#decisions) and [the answers file](#a-complete-answers-file)) | `validation-failed` ("school release requires enabled service ..."), then preflight (`service.input-missing`) | 15 minutes |

### The API token

Create it under My Profile, API Tokens, Create Custom Token. The wizard prints a link to
Cloudflare's token editor with these permissions already filled in. Scope it to the one account and
the one zone, give it a short expiry (a day is plenty), and delete it when the install finishes.

| Scope | Permission | Level |
| --- | --- | --- |
| Account | Account Settings | Read |
| Account | Billing | Read |
| Account | Workers Scripts | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Access: Apps and Policies | Edit |
| Account | Access: Organizations, Identity Providers, and Groups | Read |
| Account | AI Gateway | Edit |
| Zone | Zone | Read |
| Zone | DNS | Edit |
| Zone | Workers Routes | Edit |
| Zone | SSL and Certificates | Edit |

**Pick the account-level "Access: Apps and Policies".** Cloudflare has two permission groups with
that exact name: account-level (`1e13c5124ca64b72b1969a67e8829049`) and zone-level
(`959972745952452f8be2452be8cbb9f2`). With only the zone-level one, reads work and preflight passes,
but the install stops at `createAccessPolicy` with HTTP 403 code **1010** `auth.forbidden`
(SCHO-378). In the token editor it must sit under the Account rows; through the API, check the IDs
(`GET /user/tokens/<id>`).

Why each one is needed, and which have been verified call by call:
[installer-permissions.md](../installer-permissions.md). **Billing: Read is required**: preflight
reads the account's subscriptions to confirm Workers Paid, and without it the call answers HTTP 403
with code 10000 and preflight stops.

## Decisions

Make these before you run the installer. The wizard asks for each.

1. **Hostname: your own domain, or an educateos.io address.** Use a zone the district holds, for
   example `educateos.northfield.k12.example`. A `<slug>.educateos.io` address is **not available
   for a district's own account yet**: it needs educateos.io to publish DNS records for your account
   (Cloudflare for SaaS on your zone), which has been proven by hand on a second account (SCHO-241)
   but isn't wired into either installer. The wizard offers it only when the account holds
   educateos.io itself, which is the project's hosted demo districts. You can add an educateos.io
   alias later, once that lands.
2. **Who may sign in.** The email domains (for example `northfield.k12.example`) and individual
   addresses the Access policy admits, and the identity provider they sign in with. Access applies
   whichever login methods the Zero Trust team has; add the district IdP before the install.
3. **Administrators.** One to twenty email addresses. They are written to the backend's `ADMINS`
   variable, in your account only.
4. **The district LMS and district MCP services.** A school release (r000004 and later) refuses
   to install without both `educateos-district-worker` (`DISTRICT_CONFIG`) and
   `educateos-external-mcp` (`MCP_CONFIG`), so an AI-Workshop-only install is no longer possible on
   it. Your hostname serves the LMS at `/` and the AI Workshop at `/ai`. `DISTRICT_CONFIG` names
   its administrators by their Access subject, which nobody knows before they first sign in: start
   with a placeholder subject and `"authority": "local"`, sign in once, then put the real subject in
   and run the installer again (`packages/educateos-district-worker/README.md`). `MCP_CONFIG` names
   the district's authorization server (`packages/educateos-external-mcp/README.md`); until one
   exists, the Zero Trust team's URLs satisfy the schema, and the MCP tools stay unusable.
   **Published 0.3.0 does not ask for `MCP_CONFIG` (SCHO-439)**: use
   [the answers file](#a-complete-answers-file) and `--config`. The 0.3.1 candidate requires both
   services and asks for a district JSON file and a separate MCP JSON file. Its school-manifest
   terminal regression reaches preflight against the Cloudflare fake; publication and clean-account
   wizard acceptance are still pending. Installing both services with an answers file was verified
   on 2026-11-18 (SCHO-378).
5. **AI Gateway (turns AI on).** Yes, the default, creates one gateway in your account and turns on
   Workers AI for the Workshop from the first sign-in (`CF_AI_GATEWAY_PROVIDERS=cloudflare`,
   SCHO-445): models run in your account, billed by Cloudflare per use, with no provider keys. The
   gateway's core features are free. Anthropic and OpenAI stay off until an administrator adds a key.
   No gives a Workshop with no AI models until you add a gateway on a later run.
6. **Where to keep the answers file.** The wizard writes `educateos-install.json` (no token, no
   secrets) in the directory you run it from. Keep it, for example in the district's IT repository:
   upgrades and rollbacks reuse it.

## Steps

Durations are wall-clock for the tool to run, from the runs named. "Your time" is an estimate.

| Step | Command | Tool time | Your time | Source |
| --- | --- | --- | --- | --- |
| 1. Check the machine, the release and the token | `npx launch-educate-os doctor` | 8.4 s | 2 min | 2026-11-18, clean account (SCHO-378); 14 s on 2026-11-13, second account |
| 2. Preflight and plan, changing nothing | `npx launch-educate-os plan` | 7.8 s (18 creates) | 10 min with the questions | 2026-11-18, clean account |
| 3. Fix anything preflight blocks on, run `plan` again | | | 0 to a day: see the checklist | |
| 4. Install | `npx launch-educate-os` (answer "yes" to the plan) | **124.9 s** for 18 resources, 7 Workers | 5 min | 2026-11-18, clean account, `--config --yes`. Earlier: about 35 s for 13 resources (2026-10-26, owner account) |
| 5. Verify | see [Verify](#verify) | `plan` again: about 8 s, nothing to change | 10 min | 2026-11-18 |
| 6. Connect the LMS and roster | `npx launch-educate-os connect` (the wizard offers it) | seconds per call | 15 to 30 min per integration, plus the other system's administrator | Not yet timed: tested against simulated systems only |
| 7. Delete the API token | Cloudflare dashboard | | 1 min | |
| Uninstall | `npx launch-educate-os uninstall --confirm <instanceId>` | **22.9 s** for 16 deletes | 2 min | 2026-11-18, clean account |

With every prerequisite already in place, expect **under an hour** end to end, most of it reading
the plan and verifying. If the domain's nameservers must move to Cloudflare or the identity provider
is administered by another team, those set the schedule, not the installer.

### 1. Doctor

```sh
mkdir educateos-install && cd educateos-install
export CLOUDFLARE_API_TOKEN=...      # or leave unset and the wizard asks for it, hidden
npx launch-educate-os doctor
```

Expect `ok` for node, release (the newest signed release verifies against the keys pinned in the
installer, and shows when its statement expires), token and account. Before the wizard has run,
there are no answers to check.

### 2. Plan

```sh
npx launch-educate-os plan
```

The wizard asks for the account (it lists the ones the token sees), the hostname (it lists the
account's zones), a short installation name, the Zero Trust team (read from the account), who may
sign in, the administrators, and whether to add the LMS, the OSS admin and an AI Gateway. It then
runs preflight and prints the plan: every resource it will create, and what Cloudflare bills for.
Nothing changes. Your answers are saved to `educateos-install.json`.

### 3. Fix blocking items

Preflight prints each blocking item with what to do (see [Troubleshooting](#troubleshooting)).
Run `npx launch-educate-os plan` again; it offers to reuse your answers.

### 4. Install

```sh
npx launch-educate-os
```

Read the plan, confirm, and watch the progress lines. A run that stops partway (a network drop, a
missing permission, Ctrl-C) continues from where it stopped when you run the same command again: the
installer keeps no state of its own, it reads what's in the account.

For CI or a scripted install, with the saved answers:

```sh
npx launch-educate-os plan --config educateos-install.json --json
npx launch-educate-os install --config educateos-install.json --yes --json
```

### 5. Verify

1. `npx launch-educate-os plan` again: it should show **nothing to change** (as the 2026-11-04 run
   did).
2. Open `https://<your hostname>/` in a private window. Expect a redirect to
   `<team>.cloudflareaccess.com`, the district login, then EducateOS.
3. Sign in as one of the administrators, and as one ordinary staff account from an admitted domain.
   Someone outside the admitted domains should be refused by Access.
4. In the dashboard, Workers & Pages lists the `educateos-<name>-*` Workers, and Zero Trust, Access,
   Applications lists the EducateOS application.

### 6. Connect the LMS and roster

With the district LMS installed, the wizard ends by offering to connect the district's LMS and
roster; later, run `npx launch-educate-os connect` from the same directory (it reads
`educateos-install.json`). Do this before deleting the token: Clever and Google Classroom store
their credential as Worker secrets on the district Worker, which needs the token.

| Choose | You need | It ends with |
| --- | --- | --- |
| `canvas` or `moodle` | The LMS's administrator, and your Access token for the district (`cloudflared access token --app https://<hostname>`) | The registration approved for a first course; teachers' next steps |
| `clever` | The district's Clever ID and district-app token, from the Clever application's dashboard | `CLEVER_DISTRICT_TOKEN` set after a read of Clever with it; the roster settings to enter in the admin console |
| `google-classroom` | A Workspace super administrator: a Cloud project with the Classroom API, a service account key, domain-wide delegation of the scopes it prints | The key stored, `DISTRICT_CONFIG.classroom` written and applied, after a delegated read of Classroom |
| `oneroster` | A OneRoster 1.2 CSV export, and your Access token | The district's preview, then the roster applied if you agree |

Schoology and ClassLink aren't available yet; the menu says so (use a OneRoster CSV export from
ClassLink). Then check everything with:

```sh
EDUCATEOS_ACCESS_TOKEN=$(cloudflared access token --app https://<hostname>) npx launch-educate-os status
```

Each line is `ok`, not configured, or failing with the fix. These flows are tested against simulated
LMSs, providers and districts; none has been run against a real one through the launcher yet (the
Canvas and Moodle registrations themselves passed live runs by hand on 2026-10-26).

### 7. Delete the token

Delete the API token in My Profile, API Tokens. EducateOS keeps running; the installer has no
other access to your account. Make a new short-lived token for each upgrade.

## Upgrade and roll back

```sh
npx launch-educate-os upgrade                 # newest signed release, saved answers
npx launch-educate-os rollback                # the previous release (or --to <release-id>)
```

The installer refuses a release older than the one the account runs unless you run `rollback` or
pass `--allow-downgrade`. Rollback lists what it can't undo first: D1 migrations stay applied, and a
Worker that ran a Durable Object migration since can't go back past it.

## Uninstall

`npx launch-educate-os uninstall` shows what removing the install deletes, and
`--confirm <instanceId>` deletes it: the Workers carrying the install's marker, their custom
domains, and the Access applications and policies, AI Gateway, KV namespaces, R2 buckets and D1
databases with the install's exact names, never anything else named `educateos-<name>-*`. It never
empties an R2 bucket; empty one first. **Deleting the Workers and storage deletes the district's
data with them**; export first. The full sequence (district export, disconnecting integrations,
revoking Access and the IdP, the uninstall and confirming it, deregistering from educateos.io) is
[district-offboarding.md](district-offboarding.md). The command was added in `launch-educate-os`
0.2.0 and first ran against a live account on 2026-11-18 (SCHO-378): 16 deletes in 22.9 s (the
domain, 7 Workers, 2 Access applications, 2 policies, 3 KV namespaces and the empty R2 bucket).
Afterwards the account listed no Workers, KV namespaces, R2 buckets, Access applications or
policies, or Worker domains, and the hostname answered 530. It also cleans up a run that stopped
partway: it deletes what exists and reports the rest as gone.

## The guided-install option

- **With us, for founding pilot districts.** We run the same `npx launch-educate-os` with your IT
  team on a call, in your account, under your token. The token stays on your machine. Write to
  hello@educateos.io.
- **On educateos.io** (`/app/install`, sign in with a verified email). It runs the same installer
  from educateos.io: you paste a scoped token once, it is used for that one run and never stored,
  and the page tells you to delete it afterwards. Today it serves the install at a
  `<slug>.educateos.io` address, which works only where the account holds educateos.io, so **for a
  district's own account use the command line** until the cross-account path (SCHO-241) is wired.
  Keep the page open while it runs; a run cut off is resumed by submitting again.

## Troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| `plan.workers-paid-required` | The account has no Workers Paid subscription. | Workers & Pages, Plans: subscribe. Also seen when the token lacks Billing: Read (below). |
| `listSubscriptions` refused, HTTP 403 code 10000 | The token lacks **Billing: Read**. | Edit the token and add Billing: Read. |
| `product.r2-not-enabled`, or HTTP 403 code **10042** on R2 calls | R2 isn't enabled on the account; no token permission fixes this. | R2 in the dashboard: enable it (needs a payment method). |
| `access.idp-missing` | Zero Trust has only one-time PIN. | Zero Trust, Settings, Authentication: add the district's SAML or OIDC provider. |
| `createAccessPolicy` refused, HTTP 403 code **1010** `auth.forbidden`, after preflight passed | The token has the **zone-level** "Access: Apps and Policies" permission, not the account-level one ([The API token](#the-api-token)). | Edit the token: replace it with the account-level permission. Then run `uninstall --confirm` to clear the partial run, or just run the install again. |
| `uploadWorkerScript` refused, HTTP 403 code **10063** | The account has no workers.dev subdomain yet (`GET /workers/subdomain` answers code 10007). Also seen on an account without Workers Paid. | Open Workers & Pages in the dashboard once, which creates the subdomain; check Workers Paid. Run the install again. |
| `validation-failed`: "school release requires enabled service educateos-district-worker" (or `educateos-external-mcp`) | The answers don't enable both district services, which a school release requires. The wizard can't add the MCP one yet (SCHO-439). | Use [the answers file](#a-complete-answers-file) with `--config`. |
| `access.organization-missing` or `access.team-mismatch` | No Zero Trust team, or the answers name another one. | Create the team, or fix `access.teamName` in `educateos-install.json`. |
| `dns.zone-missing` / `dns.zone-pending` | The domain isn't an active zone in this account. | Add it and delegate its nameservers; wait for "Active". |
| `dns.record-conflict` | A DNS record already exists at the hostname. | Remove it, or choose another subdomain. |
| `dns.managed-only-cross-account` | A `<slug>.educateos.io`-only install in an account that doesn't hold educateos.io. | Set `baseDomain` to the district's own zone. |
| `permission.missing`, or HTTP 401/403 code 10000 on a call | A permission is missing from the token. The error names the operation. | Add the permission from the table above. |
| `credential.rejected`, HTTP 400 code 6003 | The token is invalid, expired or mistyped. | Make a new token. |
| `service.input-missing` / `service.secret-missing` | An optional service (for example the LMS) is enabled without its configuration. | Add `DISTRICT_CONFIG`, or turn the LMS off for this run. |
| "could not download https://educateos.io/releases/..." or "no response from Cloudflare" though the sites open in a browser | Node's connection attempts time out on a network where IPv6 is advertised but doesn't work (seen 2026-11-13). | `export NODE_OPTIONS=--network-family-autoselection-attempt-timeout=1000`, or run from another network. |
| The release refused as older than the installed one | A downgrade, or a mirror serving an old release. | `rollback`, or `--allow-downgrade` if you mean it. |
| The run stopped partway | Network, permission, or Ctrl-C. | Fix the cause and run the same command again; it continues. |

Fixed in the installer, for anyone on an old build: `GET /workers/domains` answering
`"errors": null` (2026-10-26), worker-domain deletes answering an empty body (SCHO-66), and D1
refusing `params` on multi-statement migration requests (SCHO-163, SCHO-66). Use the newest
`launch-educate-os` from npm.

## Evidence

| Date | Account | What ran | Result |
| --- | --- | --- | --- |
| 2026-10-26 | Owner account (c07a7e70) | CLI apply of `guided-trial`, then the production guided install of `guided-flow` | Both created 13 resources and served behind Access; `guided-flow` applied in about 35 s. Both removed the same day. |
| 2026-11-04 | Owner account | `npx launch-educate-os` 0.1.0 from npm, release `r000002-f690372`, at launch-trial.educateos.dev | 13 resources created; a second `plan` showed nothing to change. No duration recorded. |
| 2026-11-13 | Second account (gmacko, f84fe044, zone hbtply.com), not clean: it holds the SCHO-241 proof rig | `doctor` (14 s) and `plan` (11 s) with launch-educate-os 0.1.0 and the SCHO-241 token | Release verified; preflight blocked on `plan.workers-paid-required` and `access.idp-missing`, warned on the 50-seat limit and Worker Loader. Nothing changed. R2 is enabled there now. |
| 2026-11-18 | **Clean account** "EducateOS clean install (SCHO-378)" (304723ab), zone schoolos.dev, Zero Trust Free team `tight-paper-7186`, Workers Paid, R2 | `launch-educate-os` 0.3.0 from npm, release `r000004-15febba`, the answers file below with `--config --yes` | Install 03:37:38–03:39:43Z, **124.9 s**, 18 creates. `/` and `/ai/` redirected to the Access login, `/healthz` answered 200 `ok`, a second `plan` found nothing to change (19 resources). Uninstall 03:40:14–03:40:36Z, **22.9 s**, 16 deletes; the account then held none of the install's resources and the hostname answered 530. Two earlier attempts stopped partway and were cleared with `uninstall --confirm`: 1010 (zone-level Access permission) and 10063 (no workers.dev subdomain). |

### Reproducing the clean run

What the 2026-11-18 run needed, in order (SCHO-378):

1. A new Cloudflare account (dashboard, Create Account; `POST /accounts` is refused) with a payment
   method, then Workers Paid ($5/month), R2 (Get started; $0 base) and Zero Trust Free ($0, 50
   seats), each through its dashboard checkout. Turning on Zero Trust creates the team (a generated
   name such as `tight-paper-7186`) and adds Cloudflare's built-in login, which satisfies preflight.
2. A zone, active, with no record at the hostname (`educateos.<zone>`).
3. Open Workers & Pages once, to create the workers.dev subdomain.
4. A user API token with the 13 permissions, with the **account-level** "Access: Apps and
   Policies" (`1e13c5124ca64b72b1969a67e8829049`).
5. `NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000"`
   on networks with broken IPv6, then `doctor`, `plan --config`, the install with `--config --yes`,
   `plan` again, and `uninstall --config ... --confirm <instanceId>`, timing each.

#### A complete answers file

This is the shape of the file the run used (no secrets in it). `directory` appears twice, in both
JSON strings, and both must be the same district. The administrator's subject is a placeholder until
they first sign in. The `issuer` block points at the Zero Trust team only to satisfy `MCP_CONFIG`'s
schema; a district with an authorization server (Nathan) names it there instead.

```json
{
  "format": "launch-educate-os/1",
  "install": {
    "instanceId": "ins_schoolos-clean",
    "accountId": "<account id>",
    "baseDomain": "schoolos.dev",
    "subdomain": "educateos",
    "access": { "teamName": "<team>", "allowedEmailDomains": [], "allowedEmails": ["admin@example.org"] },
    "admins": ["admin@example.org"],
    "dataJurisdiction": "us",
    "services": {
      "educateos-district-worker": { "enabled": true, "vars": { "DISTRICT_CONFIG": "<JSON string: {directory, authority: \"local\"}>" } },
      "educateos-external-mcp": { "enabled": true, "vars": { "MCP_CONFIG": "<JSON string: {origin, directory, allowedOrigins, issuer}>" } }
    },
    "aiGateway": false
  },
  "history": []
}
```

`DISTRICT_CONFIG`, before it is stringified:

```json
{
  "directory": {
    "district": { "id": "dst_<name>", "name": "<district>", "timeZone": "America/Los_Angeles",
                  "trustedIssuers": ["https://<team>.cloudflareaccess.com"] },
    "schools": [], "terms": [], "courses": [], "offerings": [], "enrollments": [],
    "principals": [{ "id": "prn_<name>-admin", "districtId": "dst_<name>", "kind": "staff", "status": "active",
                     "displayName": "District administrator",
                     "externalIdentities": [{ "districtId": "dst_<name>", "issuer": "https://<team>.cloudflareaccess.com",
                                              "subject": "00000000-0000-0000-0000-000000000000" }] }],
    "roleAssignments": [{ "principalId": "prn_<name>-admin", "role": "district-admin",
                          "scope": { "level": "district", "districtId": "dst_<name>" }, "source": "local-grant" }]
  },
  "authority": "local"
}
```

`MCP_CONFIG`, before it is stringified (`directory` as above):

```json
{
  "origin": "https://educateos.<zone>",
  "directory": { "...": "the same directory" },
  "allowedOrigins": [],
  "issuer": {
    "issuer": "https://<team>.cloudflareaccess.com",
    "metadataUrl": "https://<team>.cloudflareaccess.com/.well-known/openid-configuration",
    "jwksUri": "https://<team>.cloudflareaccess.com/cdn-cgi/access/certs",
    "exchangeAudience": "https://<team>.cloudflareaccess.com/<name>-exchange",
    "algorithms": ["RS256"],
    "credential": "person"
  }
}
```

`metadataUrl` and `jwksUri` must share `issuer`'s origin, and `exchangeAudience` must differ from
`<origin>/mcp`, or the MCP Worker refuses the configuration.
