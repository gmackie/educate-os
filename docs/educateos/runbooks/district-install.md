# Runbook: install EducateOS in a district's Cloudflare account

- Status: Draft. No district has run this yet, and there has been **no install into a clean
  Cloudflare account**. The durations below come from recorded runs in accounts the project owner
  controls (see [Evidence](#evidence)); each one says which run it comes from. Human steps
  (subscriptions, DNS, identity provider) are estimates, not measurements.
- Issue: SCHO-363 (epic SCHO-358). Related: SCHO-241 (second-account proof), SCHO-163 and SCHO-66
  (installer fixes and permission probes).
- Audience: a district IT administrator with Super Administrator on the district's Cloudflare
  account. Public version: <https://educateos.io/it/install/>.
- Tool: [`npx launch-educate-os`](../launch-installer.md) ([package README](../../../packages/launch-educate-os/README.md)).

## What you end up with

EducateOS running in the district's own Cloudflare account, at a hostname on a domain the district
holds (by default `educateos.<your-domain>`), behind Cloudflare Access with the district's identity
provider. Every resource is named `educateos-<name>-*`. educateos.io serves the signed release
files and nothing else: it is never in the data path, holds no credential, and the install keeps
running if educateos.io is down.

The install creates (the 2026-11-04 plan for an AI Workshop install listed 13 creates):

| Kind | Count | Notes |
| --- | --- | --- |
| Workers | 5 | Router (public hostname), Workshop backend, three preinstalled gatekeepers (Context Library, Scheduled Tasks, Web Search). The district LMS Worker and the OSS admin are optional and add more. |
| KV namespaces | 3 | |
| R2 bucket | 1 | |
| D1 databases | 0 to 2 | Only with the district LMS and the OSS admin, with their migrations. |
| Access application and policy | 1 each | Admits the email domains and addresses you name. |
| Custom domain | 1 | Cloudflare creates the DNS record and certificate. |
| AI Gateway | 0 or 1 | Optional. |

## Prerequisites checklist

Have all of these before you start. The installer's preflight checks every item marked
"preflight" and stops, having changed nothing, if one is missing.

| # | Item | Checked by | Typical lead time |
| --- | --- | --- | --- |
| 1 | A machine with **Node.js 22.12 or later** (`node --version`) | `doctor` | minutes |
| 2 | A **Cloudflare account** the district owns, with a payment method | preflight (`credential.rejected`, `permission.missing`) | minutes |
| 3 | **Workers Paid** on that account (from $5/month) | preflight (`plan.workers-paid-required`) | minutes |
| 4 | **R2 enabled** (Cloudflare asks for a payment method; light use stays in the free tier) | preflight (`product.r2-not-enabled`; the API answers code 10042) | minutes |
| 5 | **Worker Loader** (dynamic Workers) available on the account | not checkable by API; preflight warns (`product.worker-loader`) | confirm with Cloudflare if unsure |
| 6 | **A domain as an active zone** in the account, with no DNS records yet at the hostname you'll use | preflight (`dns.zone-missing`, `dns.zone-pending`, `dns.record-conflict`) | minutes if already on Cloudflare; hours to a day if nameservers must move |
| 7 | **Cloudflare Zero Trust** with a team (`<team>.cloudflareaccess.com`) | preflight (`access.organization-missing`, `access.team-mismatch`) | minutes |
| 8 | **The district's identity provider** (SAML or OIDC: Google Workspace, Microsoft Entra ID, Clever, ...) added as a Zero Trust login method, besides one-time PIN | preflight (`access.idp-missing`) | depends on who administers the IdP |
| 9 | **Zero Trust seats**: Zero Trust Free admits 50 users, and every student and teacher who signs in takes a seat | preflight warns (`access.free-seat-limit`) | before the pilot opens, not before the install |
| 10 | **A scoped API token** with the 13 permissions below | `doctor`, preflight | 5 minutes |
| 11 | Optional: **AI Gateway** (free core features) | created by the installer if you say yes | none |
| 12 | Optional: a **`DISTRICT_CONFIG` file** for the district LMS (see [Decisions](#decisions)) | preflight (`service.input-missing`) | after the first administrator signs in |

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
4. **AI Workshop only, or the district LMS too.** With the LMS, your hostname serves the LMS at `/`
   and the AI Workshop at `/ai`. The LMS needs a `DISTRICT_CONFIG` file naming its administrators by
   their Access subject, which nobody knows before they first sign in. So the usual order is:
   install the AI Workshop first, sign in once, write `DISTRICT_CONFIG`
   (`packages/educateos-district-worker/README.md`), then run the installer again to add the LMS.
   **Installing the LMS through the installer has not been verified yet.**
5. **AI Gateway.** Yes gives you one gateway for usage and cost logs; its core features are free.
6. **Where to keep the answers file.** The wizard writes `educateos-install.json` (no token, no
   secrets) in the directory you run it from. Keep it, for example in the district's IT repository:
   upgrades and rollbacks reuse it.

## Steps

Durations are wall-clock for the tool to run, from the runs named. "Your time" is an estimate.

| Step | Command | Tool time | Your time | Source |
| --- | --- | --- | --- | --- |
| 1. Check the machine, the release and the token | `npx launch-educate-os doctor` | about 14 s | 2 min | 2026-11-13, second account (gmacko) |
| 2. Preflight and plan, changing nothing | `npx launch-educate-os plan` | about 11 s to preflight | 10 min with the questions | 2026-11-13, second account; 2026-11-04, owner account (reached the 13-create plan) |
| 3. Fix anything preflight blocks on, run `plan` again | | | 0 to a day: see the checklist | |
| 4. Install | `npx launch-educate-os` (answer "yes" to the plan) | about 35 s to apply | 5 min | 2026-10-26, owner account, the same installer through the guided install (13 resources and 171 file uploads). The 2026-11-04 `npx` install recorded no duration. |
| 5. Verify | see [Verify](#verify) | | 10 min | |
| 6. Delete the API token | Cloudflare dashboard | | 1 min | |

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

### 6. Delete the token

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

There is no uninstall command. In the Cloudflare dashboard, delete everything named
`educateos-<name>-*`: the Workers, KV namespaces, the R2 bucket, the D1 databases, the AI Gateway,
the Workers custom domains (deleting the Worker removes its custom domain and DNS record with it),
and the Access application and policy. **Deleting the Workers and storage deletes the district's
data with them**; export first. The full sequence (district export, disconnecting integrations,
revoking Access and the IdP, deletion and confirming it) is [district-offboarding.md](district-offboarding.md). This is how the 2026-10-26 trial installs were removed (10 Workers,
6 KV namespaces, 2 R2 buckets, 4 domains, 2 Access applications and 2 policies); afterwards the
hostnames answered 530.

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

### What a clean, timed run still needs

A Cloudflare account that holds nothing else, which the project owner provides:

1. Workers Paid on it, and R2 enabled (payment method on file).
2. A zone in it (a spare domain, delegated to Cloudflare), with no record at the chosen hostname.
3. Zero Trust with a team and one non-PIN identity provider (a free GitHub or Google OIDC login is
   enough for the test).
4. An API token with exactly the 13 permissions above, scoped to that account and zone, stored in
   the Keychain (for example `educateos-cf-clean-install-token`), and an OK to create the 13
   resources and remove them afterwards.

Then run steps 1 to 6 with timestamps, record them here, and uninstall per [Uninstall](#uninstall).
