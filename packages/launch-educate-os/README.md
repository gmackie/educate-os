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
- **District and MCP configuration JSON files** for a school release (`DISTRICT_CONFIG` and
  `MCP_CONFIG`). The wizard enables both required services and asks for each file; it does not
  offer Workshop-only installation for a school release. Configuration formats are documented in
  the district Worker and external MCP package READMEs. Keep the files and saved answers private.

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

Check that **Access: Apps and Policies** is under **Account**, not Zone. Cloudflare gives both
groups the same name; the required account group is `1e13c5124ca64b72b1969a67e8829049`.
The token-editor prefill alone does not verify this scope.

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
   for the installation, the Zero Trust team (found in the account; with only Cloudflare-account
   login or one-time codes, it offers to add Google Workspace or Microsoft Entra ID sign-in), which email domains and
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
- **An AI Gateway** (the default), which turns on Workers AI for the AI Workshop from the first
  sign-in: it runs in your account, billed by Cloudflare per use, with no provider keys.

The installer never touches a resource it didn't create: anything without its marker is reported,
not changed.

### The district LMS

With the district LMS, your hostname serves the LMS at `/` and the AI Workshop at `/ai`. The wizard
writes its configuration from a few answers: your district's name, its time zone and each
administrator's name. The district starts with no people. Each administrator you named becomes the
district's administrator the first time they sign in with that email, and can open the AI
Workshop's admin settings; nobody needs to know a sign-in ID in advance. Staff can create AI
Workshop workspaces and chat from the start; students stay off until you turn them on. You can
give your own JSON files instead (`DISTRICT_CONFIG`, documented in the EducateOS repository's
`packages/educateos-district-worker/README.md`). The open-source admin needs the LMS.

## Commands

```sh
npx launch-educate-os            # the wizard (same as `install`)
npx launch-educate-os plan       # preflight and plan only; changes nothing
npx launch-educate-os upgrade    # install the newest release, with your saved answers
npx launch-educate-os rollback   # return to the previous release (or --to <release-id>)
npx launch-educate-os doctor     # check Node, the release source, the token and the account, then `status`
npx launch-educate-os connect    # connect the district's LMS and roster (see below)
npx launch-educate-os status     # what the district is connected to, and whether it works
npx launch-educate-os mcp ...    # set up MCP: status, clients, add (see "MCP" below)
npx launch-educate-os ai ...     # turn on Anthropic or OpenAI with your own key (see "AI providers" below)
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

## Connect your LMS and roster

With the district LMS installed, the wizard ends by offering **Connect your LMS and roster now?**,
which is the same as running:

```sh
npx launch-educate-os connect              # a menu
npx launch-educate-os connect canvas       # or name one
```

Each integration says what it gives the district and what you need first, shows the exact steps
and values for the other system, stores what the district reads, and ends with a live check and
what teachers do next. Nothing changes in your account without a confirmation (or `--yes`).

| Integration | What the launcher does | Where it is stored | Live check |
| --- | --- | --- | --- |
| `canvas`, `moodle` | Creates a single-use LTI 1.3 Dynamic Registration invitation, gives the click path in Canvas or Moodle, then trusts the LMS's issuer and approves its registration for a course. | In the district (its admin API, `/api/lti/*`). | The Tool's keys at `/lti/jwks`, and the registration approved. |
| `clever` | Asks for your Clever district ID and district-app token (hidden). | The district Worker's secret `CLEVER_DISTRICT_TOKEN`. | Reads Clever's API v3.1 with the token: your district, then its users. |
| `google-classroom` | Asks for the service account's JSON key file, a Workspace administrator, and a term and school; prints the domain-wide delegation scopes. | The district Worker's secret `GOOGLE_CLASSROOM_SERVICE_ACCOUNT_KEY`, and `DISTRICT_CONFIG.classroom` in your answers file, applied for you. | A delegated token as the administrator, then a Classroom read. |
| `oneroster` | Reads a OneRoster 1.2 CSV export directory. | In the district (`/api/admin/roster/preview`, then `apply`). | The district's preview of every change; it applies only if you agree. |
| `schoology`, `classlink` | Not available yet: says why and what to use instead. | | |

The steps in the district run as a district administrator, so they need your own Cloudflare Access
token for the district (`cloudflared access login https://<district>` then
`cloudflared access token --app https://<district>`), pasted hidden or set as
`EDUCATEOS_ACCESS_TOKEN`. Without it, the launcher prints the requests to make instead. Worker
secrets are set with the Cloudflare API token (`CLOUDFLARE_API_TOKEN`; Workers Scripts: Edit).

`npx launch-educate-os status` reads everything and changes nothing: the district answers, Access
asks people to sign in, the LTI Tool publishes its keys, which LMSs are registered, which roster
credentials are set, and whether the roster sync can run, each with the fix when it isn't working.
Exit code 1 when something is failing.

In CI (`--json` gives one `connect` or `status` event):

```sh
EDUCATEOS_ACCESS_TOKEN=... npx launch-educate-os connect canvas --json        # prints the invitation
EDUCATEOS_ACCESS_TOKEN=... npx launch-educate-os connect canvas --yes --issuer https://<district>.instructure.com \
  --context-id <lti_context_id> --offering-id off_... --deployment-id <id>     # approves it
EDUCATEOS_CLEVER_DISTRICT_TOKEN=... npx launch-educate-os connect clever --clever-district-id <id> --yes
npx launch-educate-os connect google-classroom --service-account-key key.json --workspace-admin admin@district.org \
  --classroom-roster classroom-roster.json --yes
EDUCATEOS_ACCESS_TOKEN=... npx launch-educate-os connect oneroster --csv-dir ./oneroster-export --yes
npx launch-educate-os status --json
```

What is proven where: Canvas and Moodle registrations passed live runs (a self-hosted current Canvas
and Moodle 4.5, 2026-10-26), though not through this command. The Clever, Google Classroom and
OneRoster flows, and `connect` itself, are tested against simulated providers and a simulated
district only; no real roster has been imported through them yet.

## AI providers

Workers AI is on from the first sign-in. To add Anthropic or OpenAI, paste the district's API key
once:

```sh
npx launch-educate-os ai add anthropic     # or: ai add openai
npx launch-educate-os ai status            # what is on, and which keys your gateway holds
npx launch-educate-os ai remove anthropic  # turn it off again
```

`ai add` tells you what turning the provider on means (what staff and students type in the AI
Workshop goes to that provider), asks for the key without showing it, checks it with the provider
through your AI Gateway (no model runs), stores it in that gateway in your Cloudflare account, and
turns the provider on. The key is never saved in the answers file or printed. The Cloudflare API
token needs **AI Gateway: Edit** and **Secrets Store: Edit** besides the install's permissions.
Without a terminal, set `EDUCATEOS_ANTHROPIC_API_KEY` or `EDUCATEOS_OPENAI_API_KEY` and pass
`--yes`.

## MCP

`npx launch-educate-os mcp` helps you set up MCP (the Model Context Protocol) after an install. There
are two separate things:

- **Your district's own MCP endpoint**, `https://<your hostname>/mcp`, which outside AI clients
  (Claude, ChatGPT, Claude Code, VS Code, Cursor) call to reach school tools under district policy.
  It is off by default; `DISTRICT_CONFIG.mcp` turns it on.
- **The AI Workshop's MCP connectors**, which let Workshop agents call outside MCP servers: the
  **MCP Server** connector (`gatekeeper-mcp`, for any server an administrator pastes the address
  of) and the **MCP Server Portal** connector (`gatekeeper-mcp-portal`, for one portal).

```sh
npx launch-educate-os mcp status                  # what's set up, with live checks
npx launch-educate-os mcp clients                 # connect AI clients to your district's /mcp
npx launch-educate-os mcp clients --client claude # one client's steps
npx launch-educate-os mcp add --server-url https://mcp.example.org/mcp   # add an MCP server to the Workshop
npx launch-educate-os mcp add --connector portal --portal-url https://portal.example.org/mcp   # or an MCP portal
```

- **`mcp status`** reads the answers file: whether `DISTRICT_CONFIG.mcp` turns the endpoint on, its
  issuer (and whether the district trusts it), which MCP connectors the answers install, and whether
  `DISTRICT_CONFIG.workshopPolicy` lets district administrators connect them. Then it checks live:
  the endpoint's OAuth metadata (`/.well-known/oauth-protected-resource/mcp`) and the 401 an
  unauthenticated request gets. With `CLOUDFLARE_API_TOKEN` set, it also checks the connectors'
  Workers in your account, and the portal's address. Which connectors the Workshop offers is a
  Workshop setting (`/ai/admin?tab=gatekeepers`), which the launcher can't read.
- **`mcp clients`** prints the endpoint's URL, how sign-in works, who may use it, a live check of
  the authorization server (can clients register themselves, PKCE), and each client's steps and
  config snippet. `--url <endpoint>` works without an answers file.
- **`mcp add`** checks a server the way the Workshop's connector will (an MCP `initialize` with no
  credentials, then its OAuth metadata and whether the connector can register there), then adds
  `gatekeeper-mcp` to `gatekeepers` and a `{"vendorId": "mcp", "access": "all"}` grant to
  `DISTRICT_CONFIG.workshopPolicy.connectors` (district administrators may connect MCP servers;
  teachers may not). It shows the changes and asks first (`--yes` without a terminal). Apply them
  with `npx launch-educate-os --config educateos-install.json`, then connect the server in the
  Workshop: it prints the steps.
- **`mcp add --connector portal`** (added in 0.3.0) sets up the MCP Server Portal connector instead: one portal (such
  as a Cloudflare MCP server portal) for the whole install. It writes the portal's URL and, if given,
  its display name (`--portal-name`) and sign-in (`--portal-auth oauth|token|none`, default oauth) to
  `gatekeeperInputs`, adds `gatekeeper-mcp-portal` to `gatekeepers`, and grants `mcpportal` to
  district administrators. On a terminal it asks for each. For `token` sign-in, set
  `EDUCATEOS_SECRET_GATEKEEPER_MCP_PORTAL__MCP_PORTAL_TOKEN` when you apply: the answers file never
  holds the token.

Every MCP command reads and changes only the answers file and never Cloudflare. Live checks send
no token or cookie. `--offline` skips them; `--json` prints `mcp`, `mcp-client` and `mcp-change`
events.

What isn't ready yet:

- **The district endpoint has no live sign-in yet.** It is built and tested with the official MCP
  client against a simulated authorization server, but the district's authorization server (Nathan)
  doesn't issue tokens for it yet, and no outside client has connected. (Applying answers that turn
  it on exempts `/mcp` and its OAuth metadata from Cloudflare Access.) Each person's delegation to a
  client is issued through the district API; there is no page for it yet.
- **No portal has been connected through the MCP Server Portal connector** in an EducateOS district.
- **Not run against a live district.** The commands are tested against simulated endpoints and the
  installer's simulated Cloudflare.

The full guide is `docs/educateos/mcp-setup.md` in the EducateOS repository.

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

`npx launch-educate-os uninstall` removes the install, for a district leaving EducateOS. Deleting
the Workers and storage deletes the district's data with them, so export the district first (a
district administrator: the admin console's **Export the district**). Then:

```sh
npx launch-educate-os uninstall                            # the plan: what would be deleted; changes nothing
npx launch-educate-os uninstall --confirm ins_<name>       # deletes it
```

It deletes only what the installer made for this install: Workers carrying the install's marker,
and the custom domains, Access applications and policies, AI Gateway, KV namespaces, R2 buckets and
D1 databases with the install's exact names. Anything else named `educateos-<name>-*` is listed as
`unclaimed` and left alone. On a terminal it asks you to type the instance ID; `--yes` never
deletes. It never deletes objects in R2: empty a bucket that still holds files first (a lifecycle
rule expiring every object does it for a large one), then run it again. It continues from whatever
is left, so re-running after any failure is safe.

Not yet run against a live Cloudflare account: it is tested against the installer's simulated one.
It was added in 0.2.0.

## License

Apache-2.0. See [LICENSE](LICENSE).
