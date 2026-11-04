# launch-educate-os

Install [EducateOS](https://educateos.io) into your own Cloudflare account:

```sh
npx launch-educate-os
```

EducateOS is a district-owned K-12 LMS and AI Workshop. It runs in the district's own Cloudflare
account, under the district's control, and keeps running whether or not educateos.io is up. This
package is the installer: a guided wizard on a terminal, and a non-interactive mode for CI.

## Before you start

You need:

- **Node.js 22.12 or later**, for `npx`.
- **A Cloudflare account on Workers Paid** (from $5/month). EducateOS uses Durable Objects, Cron
  Triggers and the Worker Loader binding.
- **R2 enabled** on the account. Cloudflare asks for a payment method; light use stays in the free tier.
- **A domain on Cloudflare**: an active zone in the account. EducateOS is served at
  `educateos.<your-domain>` by default (you choose the subdomain).
- **Cloudflare Zero Trust**, with a team and your district's identity provider (SAML or OIDC)
  added. Everyone signs in through Cloudflare Access.
- **A Cloudflare API token** with the permissions below. The wizard prints a link to Cloudflare's
  token editor with them prefilled.

The installer checks all of this before it changes anything (preflight), and tells you what to do
about anything missing.

### Token permissions

Scope the token to the one account and zone, give it a short expiry, and delete it when the install
finishes.

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

Why each one is needed: [installer permissions](https://github.com/gmackie/educate-os/blob/main/docs/educateos/installer-permissions.md).

## What it costs

EducateOS itself is free and open source (Apache-2.0). Everything it runs on is billed to you by
Cloudflare, under your account:

- Workers Paid: the base subscription, plus requests and CPU time over its allowance. KV, D1 and
  Durable Objects usage counts against it. AI Gateway's core features are free.
- R2: stored data and operations.
- Workers AI: per use, for the AI Workshop.
- Zero Trust: Zero Trust Free admits 50 users. Every student and teacher who signs in takes a seat,
  so most districts need paid seats.

The plan the installer shows ends with every billable resource it will create.

## What it does

1. **Release.** Downloads the newest signed EducateOS release from `https://educateos.io/releases/`
   (or `--release <id>`, or a directory with `--release-dir`), and verifies it (see "Security").
2. **Questions.** The Cloudflare token (typed hidden, or `CLOUDFLARE_API_TOKEN`), the account
   (it lists the ones the token can see), the hostname (it lists the account's zones), a short name
   for the installation, the Zero Trust team (found in the account), which email domains and
   addresses may sign in, the administrators, and whether to install the district LMS and the
   open-source admin.
3. **Preflight.** Checks the plan, products, quotas, DNS, Zero Trust and the token's permissions.
   It changes nothing.
4. **Plan.** Lists every resource it will create or update, and what each costs.
5. **Apply**, after you confirm, with live progress.
6. **Done.** Prints your URLs and next steps.

Your answers (never the token or any secret) are saved to `./educateos-install.json`. Run the same
command again and it offers to reuse them. The installer keeps no other state: it reads what is in
your account, so a run that stops partway (a network drop, a missing permission, Ctrl-C) continues
from there when you run it again.

### What gets created

All in your account, all named `educateos-<name>-*`:

- **Workers**: the router (your public hostname), the Workshop backend, the preinstalled
  gatekeepers (Context Library, Scheduled Tasks, Web Search), and, if you choose them, the district
  LMS Worker and the open-source admin.
- **Storage**: KV namespaces, an R2 bucket and, for the district LMS and the admin, D1 databases
  (with their migrations).
- **Cloudflare Access**: an application in front of your hostname, and a policy admitting the
  email domains and addresses you named.
- **A custom domain** for the hostname (Cloudflare creates its DNS record and certificate), and the
  admin's, if chosen.
- **An AI Gateway**, if you choose one.

The installer never touches a resource it didn't create: anything without its marker is reported,
not changed.

### The district LMS

With the district LMS, your hostname serves the LMS at `/` and the AI Workshop at `/ai`. It needs a
district configuration: a JSON file with your district, its trusted issuers and the administrators
who will import the roster (`DISTRICT_CONFIG`, documented in the EducateOS repository's
`packages/educateos-district-worker/README.md`). Without one, the installer installs the AI
Workshop on its own, and you can add the LMS on a later run. The open-source admin needs the LMS.

## Commands

```sh
npx launch-educate-os            # the wizard (same as `install`)
npx launch-educate-os plan       # preflight and plan only; changes nothing
npx launch-educate-os upgrade    # install the newest release, with your saved answers
npx launch-educate-os rollback   # return to the previous release (or --to <release-id>)
npx launch-educate-os doctor     # check Node, the release source, the token and the account
```

| Option | Meaning |
| --- | --- |
| `--config <file>` | The answers file (default `./educateos-install.json`). With it, nothing is asked. |
| `--yes` | Apply without asking. Required when there is no terminal. |
| `--plan-only` | Stop after the plan. |
| `--json` | One JSON event per line on stdout (`release`, `preflight`, `plan`, `step`, `done`, `error`), for CI. Human text goes to stderr. |
| `--release <id>` | Install this release instead of the newest. |
| `--release-dir <dir>` | Read the release from a directory (offline or air-gapped). |
| `--release-url <url>` | Read releases from another mirror of educateos.io's `/releases/`. |
| `--trust <file>` | Verify releases against these release keys instead of the built-in EducateOS keys, for releases you build and sign yourself. |
| `--allow-downgrade` | Let `install` or `upgrade` move to an older release. |
| `--to <id>` | `rollback`: the release to return to. |
| `--current-release-dir <dir>` | `rollback` offline: the installed release's directory. |
| `--registry-url <url>` | Register with this registry after applying (needs `fleet` in the answers). |

Environment:

- `CLOUDFLARE_API_TOKEN`: the API token. Without it, the wizard asks for it, hidden.
- `EDUCATEOS_SECRET_<PACKAGE>__<NAME>`: a gatekeeper's or service's secret, such as
  `EDUCATEOS_SECRET_GATEKEEPER_GOOGLE__CLIENT_ID`. On a terminal, the installer asks for any
  secret the release needs that isn't set; otherwise it names the variables to set.

### In CI

```sh
export CLOUDFLARE_API_TOKEN=...   # from your CI's secret store
npx launch-educate-os plan --config educateos-install.json --json
npx launch-educate-os upgrade --config educateos-install.json --yes --json
```

Exit codes: 0 done, 1 blocked or failed (nothing further changed), 2 usage (or a confirmation was
needed and `--yes` wasn't given), 130 stopped by the operator.

## Security

- **Signed releases only.** Every release is verified against the EducateOS release keys pinned
  in this package before anything is installed: the root's signed statement, then the manifest
  against the statement's SHA-256, then each Worker module against the manifest as it is uploaded.
  `latest.json` only names a release: a release it names still has to verify, and it must be the
  release it claims to be.
- **No silent downgrades.** If the release offered is older than the one installed, the installer
  refuses unless you run `rollback` or pass `--allow-downgrade`.
- **The token stays with you.** It is read from `CLOUDFLARE_API_TOKEN` or typed hidden, sent only to
  `api.cloudflare.com` (the client never follows a redirect), never written to disk, and redacted
  from all output. Errors name the failing operation and Cloudflare's error codes, never the
  request. The same goes for gatekeeper and service secrets.
- **educateos.io is never in the path.** The installer only downloads releases from it. Registering
  the installation with educateos.io is off, and isn't available from this installer yet.

## Rollback and uninstall

`npx launch-educate-os rollback` returns every Worker to the previous release's version. It shows
what it can't undo first: D1 migrations stay applied, and a Worker that ran a Durable Object
migration since can't go back past it.

To uninstall, delete the `educateos-<name>-*` Workers, KV namespaces, R2 bucket, D1 databases,
AI Gateway, custom domains and Access applications in the Cloudflare dashboard. Deleting the
Workers and storage deletes the district's data with them, so export anything you need first.

## License

Apache-2.0. See [LICENSE](LICENSE).
