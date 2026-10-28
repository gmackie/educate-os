# The educateos.io control plane

- Status: operator sign-in, the store, the opt-in registry, the installation dashboard, Clever
  portal launches (SCHO-249) and the guided install. Billing (SCHO-208) and the marketplace
  (SCHO-209) build on this.
- Issue: SCHO-206. Decision record: [ADR-0013](adr/0013-educateos-open-core-control-plane.md).
- Code: `packages/educateos-control-plane`, served by the site Worker in `sites/educateos-io`.

educateos.io is optional. An installation runs in its district's own Cloudflare account and never
needs educateos.io to serve, sign anyone in or update (ADR-0013). The control plane is where an
operator signs in, sees the installations they made, and, once the guided install lands, installs
into their own account. It is never in an installation's data path.

## Where it runs

The control plane is part of the `educateos-site` Worker, which already serves the static site on
educateos.io, www.educateos.io, educateos.dev and www.educateos.dev. Static files are still served
before any script runs. Only the paths in `assets.run_worker_first` reach the Worker first:

| Path | What answers |
| --- | --- |
| `/healthz` | JSON `{"status":"ok","commit":…}` once the store answers. ForgeGraph's health check. |
| `/registry/v1/heartbeat` | The opt-in instance registry's heartbeats: signed by the installation, no sign-in. |
| `/app/install` | The guided install: the form (GET) and the run (POST), inside the console. |
| `/app`, `/app/*` | The operator console, behind Cloudflare Access, on educateos.io only. The other hostnames redirect there, since the Access application covers only `educateos.io/app`. |
| `/clever/launch` | Clever portal launches, sent on to the registered installation for the user's Clever district (SCHO-249). No sign-in. See [Clever portal launches](#clever-portal-launches). |

Anything else that reaches the script goes back to the assets binding and its 404 page. The paths
live under `/app` on the apex rather than at `app.educateos.io`. `app` is a reserved slug either
way (`packages/educateos-installer/src/slug.ts`), but a path needs no new custom domain or
certificate, and the Access application can be scoped to it.

## Delivery: its own ForgeGraph app

The site deploys through ForgeGraph app `educateos-site`, not as a target of the primary
`educate-os` app. SCHO-229 registered it and SCHO-233 made its deploys pass the source-order guard.
Every merge to main deploys it, and the target's `healthCheckUrl` checks the live site.

The evidence for keeping it separate:

- **Failure isolation.** As of 2026-10-26 the app's production history held 46 deploys: 32 failed
  (30 source-order refusals while the Worker was still assets-only, SCHO-233), 12 were rolled
  back, and 1 is active. As a target of `educate-os`, each failure would have held back the
  primary app's `production.healthy`, and with it the delivery receipts of unrelated district PRs.
- **ADR-0013's boundary.** The control plane is the project's own optional service, not part of a
  district release. Keeping it out of the primary app keeps it out of the release unit, as
  `sites/` keeps it out of release discovery.
- **The cost.** Kanbanger receipts come only from the primary app, so a site PR is credited by
  `educate-os`'s production deploy of a commit containing it, not by the site's own deploy. Record
  the `educateos-site` deployment ID and health on the issue as well.

Production deploy at the time of this decision: deployment `c7246aa8-cbde-405e-8b6d-7fa79d8bcec8`,
commit `804199b5`, Cloudflare version `aa165a73-8b77-4754-b0e3-ce16e5557e2e`, active
2026-10-26T14:01Z. Every page, the PDF and `/demo/` returned 200, `/demo/` kept
`Cache-Control: no-transform`, and an unknown path returned 404.

## Operator sign-in: Cloudflare Access

The Access application **EducateOS operator console** (`9074c7b7-1276-4135-a204-277b08a89567`,
audience `a44a7642…`) covers `educateos.io/app` and `educateos.io/app/*` in team `gmacko`.
Its one policy admits everyone, and its sign-in methods are one-time PIN and GitHub. So anyone who
proves an email address can become an operator, and sees only their own installations.

The Worker verifies every request's `Cf-Access-Jwt-Assertion` as the district Worker does: the
signature against the team's published certs (RS256 only), the issuer, this application's audience
and the expiry. It then reads the identity with `@educateos/identity`. Service tokens and
assertions without a valid email are refused. The operator is keyed by the Access `sub`, which
Access makes unique to an email address in the account, and the email is kept only for display.

Why Access rather than an emailed magic link:

- **No credential code to own.** Access sends and checks the PIN, rate-limits it, and keeps the
  session. The control plane holds no password, PIN, session secret or signing key of its own.
- **Email Routing cannot send it.** A Worker's `send_email` binding reaches only verified
  destination addresses, so a magic link to an arbitrary operator would need Cloudflare Email
  Sending on educateos.io, plus link tokens, replay protection and a session cookie, all
  hand-written.
- **It is already proven here.** The demo districts sign in through the same team, and the agent
  test identities can sign in to it (`agent-inbox` `access-sign-in.ts`).
- **The limit.** Zero Trust Free admits 50 users per account, and operators share those seats with
  the account's other Access applications, the demo districts included. Before operators number
  in the dozens, either buy seats or replace Access with Email Sending magic links behind the same
  `OperatorVerifier` signature; the routes don't change.

Access sets its sign-in cookies (`CF_Authorization` on educateos.io, and its own on the team's
sign-in page) only when an operator signs in. Visitors who never sign in get none. Cloudflare keeps
each sign-in in the account's Access logs. The privacy policy says all of this.

## Storage: one SQLite Durable Object

`ControlPlane` (binding `CONTROL_PLANE`, one instance named `educateos.io`) holds two tables:
operators, and the installations each one made through educateos.io. A Durable Object rather than D1
because:

- the repository's other stores are SQLite Durable Objects built on `@educateos/fleet`'s
  `DurableObjectTables`, and so is this one;
- a deploy needs only `wrangler deploy`, with no separate migration step and no D1 permission on
  the deployer's token; and
- one writer makes a slug's uniqueness, and later the registry's first-come writes, atomic.

The Worker now owns data, so it must keep the name `educateos-site` and the class `ControlPlane`: a
new name starts an empty namespace (SCHO-231). `sites/educateos-io/site-config.test.mjs` fails if
either changes, or if a migration deletes or renames the class.

## Pages

The console is server-rendered HTML in the site's own shell: the stamped header and footer from
`sites/educateos-io/partials`, Kumo tokens and `site.css`. It ships no framework. Every value is
escaped by the `html` template tag. Each page is `no-store` and sent under a CSP that admits no
script except the site's theme switch, by hash.

## The opt-in registry

SCHO-155 left the registry without storage or a server: `@educateos/fleet`'s `InstanceRegistry` had
only an in-memory store. The control plane now hosts it over `DurableObjectRegistryStorage`
(`src/registry-store.ts`), whose writes are atomic in the same Durable Object: first-come
registration, single-use keys and sequence numbers.

- **Registration happens only inside the control plane.** The guided install registers the
  installation while it holds the install, and only if the operator asked. There is no HTTP
  `register` route, so someone who learns an instance's IDs can't register it first and lock the
  real installation out of its own registration.
- **The commercial account is the operator's `acct_…` ID.** `verifyRegistration` also requires that
  this operator installed the instance.
- **Heartbeats arrive at `POST /registry/v1/heartbeat`.** The Worker reads at most 64 KiB, whatever
  Content-Length says, and checks the envelope's shape before the Durable Object sees it.
- **Still to do.** CLI-installed instances can't register yet, since claiming one is follow-up work.
  Nothing in the runtime sends heartbeats yet either, so a registered installation shows its
  registration and installed version, and reports appear once a heartbeat sender exists.
- **Before traffic grows,** add a rate limit on `/registry/*`. The one Durable Object also serves
  sign-in and the dashboard.

## Clever portal launches

Clever sends portal and Instant Login launches to the app's first redirect URI with a code and no
`state`, which a district's Access application would refuse. The educateos.io Clever app lists
`https://educateos.io/clever/launch` first instead ([ADR-0013 addendum A2](adr/0013-educateos-open-core-control-plane.md#addendum-a2-2026-10-26-scho-249-clever-portal-launches-pass-through-educateosio)).
`src/clever-launch.ts` answers it:

1. GET only. HEAD is answered without spending the code, and other methods get 405.
2. The code is exchanged at `https://clever.com/oauth/tokens` (HTTP Basic with the app's client,
   `redirect_uri` exactly `https://educateos.io/clever/launch`).
3. The token reads `https://api.clever.com/v3.0/me` once, for `data.district`, and is dropped.
4. The registry maps that Clever district to an installation, and the answer is a 303 to
   `https://<slug>.educateos.io/`. The district's Access application then signs the user in
   through Clever itself.

Every response is `no-store` and `no-referrer`. A missing code, an unconfigured Worker, a refused
exchange or identity read, and an unknown district each get a plain page that names none of the
values involved; the log line names only which of those it was.

**Which districts it serves.** Only installations registered in the opt-in registry with a Clever
district ID (`control_plane_registry_clever_districts`). The ID is written by the Durable Object's
`linkCleverDistrict`, which, like registration, is never served over HTTP; a Clever district names
one installation, first come. Installations that never opted in, and the demo districts (which are
not control-plane installations), can't take portal launches: their users start from the district's
own address, except those named in the site Worker's `CLEVER_LAUNCH_DISTRICTS` var: a JSON map from
Clever district ID to a `<slug>.educateos.io` hostname, consulted only when the registry has no
match. It is a demo bridge until the guided install writes installation rows; today it maps the
`educateos-dev` sandbox district `6ade41569b8cebb96d733c48` to `northfield.educateos.io`. Before
the guided install offers the link, it needs a proof that the operator speaks for that Clever
district.

**Users in no district.** Clever places a teacher who authorized the app themselves in no district:
`/me` names none, the user record's roles carry only a legacy ID, and the user's district record is
a 404. Every sandbox demo login is one. Such a launch goes to the site Worker's
`CLEVER_LAUNCH_UNAFFILIATED` hostname (today `northfield.educateos.io`) and is otherwise refused
with `no-district`. The redirect grants nothing: the district's own sign-in still decides who gets
in.

**Setup.**

- The Clever app's first redirect URI is `https://educateos.io/clever/launch`. Each district's own
  Access callback stays on the list after it, for "Log in with Clever".
- The site Worker's secrets `CLEVER_CLIENT_ID` and `CLEVER_CLIENT_SECRET` hold the app's OAuth
  client (`wrangler secret put`, never `wrangler.jsonc`). Without both, every launch gets the
  "unavailable" page.

## The installation dashboard

`/app/` (and `/app/api/installations` as JSON) lists the operator's installations, read-only:

| Column | Source |
| --- | --- |
| Installation, installed | The control plane's installation record, written by the guided install |
| Address | The managed hostname, `<slug>.educateos.io` (SCHO-207) |
| Version | The registry's last reported version, else the installed one |
| Health | A probe of `https://<hostname>/healthz` while the page loads: responding, behind sign-in, an HTTP status, or unreachable |
| Registry | Registered or not; last report; how many reported probes are ok |

Only managed hostnames (`<slug>.educateos.io`) are stored or probed. At most 50 are probed, six at
a time. The probe is an ordinary request to the router's `/healthz`, which reads nothing and returns
nothing about the instance. It runs only while the operator has the page open, and keeps only the
status. An installation behind Access without a `/healthz` bypass shows as "behind sign-in": Access
answered, so the instance's own state is unknown. The site Worker sets
`global_fetch_strictly_public`, so a probe of a hostname on the educateos.io zone reaches that
hostname's Worker as a visitor's request would.

## The guided install

`/app/install` runs `@educateos/installer` from educateos.io into the operator's own Cloudflare
account (`src/guided-install.ts`). The form asks for:

- the slug, which becomes `<slug>.educateos.io`;
- the account ID and a zone in that account (EducateOS also serves at `<slug>.<zone>`);
- the Zero Trust team, the email domains that may sign in, and the administrators;
- whether to register with educateos.io (off by default); and
- a Cloudflare API token.

**The token.** Cloudflare's OAuth would make this a revocable grant, but no public OAuth client is
registered (SCHO-67, `installer-oauth.md`). So the operator pastes a scoped API token once. The form
links to Cloudflare's token editor prefilled with exactly the permissions in
`installer-permissions.md` (`INSTALL_TOKEN_PERMISSIONS`). The token:

- lives only in the POST that runs the install, inside the installer's static token provider;
- goes only to api.cloudflare.com;
- is never stored, logged or echoed (tests assert it appears in no event, page or rejected form);
- is dropped when the run ends.

The page then tells the operator to delete it. A token that doesn't verify stops preflight before
anything changes.

**The release.** The newest `releases/<id>/` in the `educateos-releases` R2 bucket (binding
`RELEASES`, laid out by `scripts/release/upload-release.ts`). Before anything is installed, its
signed statement is verified against `RELEASE_TRUST` and its manifest bytes against the statement,
exactly as the CLI verifies a release. The installer then checks every blob's hash as it uploads.

**The run.**

- It streams as the page itself, one line per applied step, with no script.
- **The slug is reserved** in one Durable Object transaction before the first Cloudflare call
  (`reserveInstall`). The reservation holds:
  - the operator and account it belongs to;
  - the slug's instance ID;
  - a 30-minute run lease.
- A slug another operator or account holds is refused. So is a second run while one holds the
  lease, which covers a double submit.
- **Resuming.** The operator who holds the slug may run the install again, to resume or upgrade.
  The re-run reuses the reserved instance ID, so the installer's ownership checks see the same
  instance. For a slug over 20 characters, the ID suffix is a hash of the slug, not random.
- **Ending a run.** A run that changed nothing (refused before the installer touched the account)
  gives the slug back. Any other run keeps it.
- **Keep the page open.** The install runs in the request; `waitUntil` only covers about 30 seconds
  after the browser goes away. A run that is cut off is resumed by running the install again.
  The CLI install of the same release made about 13 resource changes plus 171 blob uploads. Its
  request count against the Workers subrequest limit is measured on the first production guided
  install (see SCHO-206).
- **Recording.** On success, the installation is recorded for the dashboard. If the operator opted
  in, it is then registered from inside the control plane (see "The opt-in registry"). If the
  install lands but the record fails, the page says so, and a re-run records it.
- **Release downgrade.** Whoever can write to the release bucket could delete newer releases so an
  older signed one installs. Today that is only the project owner. A signed "latest" pointer or a
  pinned minimum would close it.
- **Redirects.** The installer's Cloudflare client never follows one, so the token can't leave
  api.cloudflare.com.

**Limits.**

- Only the same-account managed hostname path is wired. That is the path where the operator's
  account also holds the educateos.io zone, as every demo district does (ADR-0013 addendum A1).
- The cross-account path needs educateos.io's own DNS token for the zone half (`applyManagedZone`)
  and is still unproven on a second account (SCHO-241).
- No gatekeeper beyond the release's preinstalled ones is offered yet.

### Release keys

No release key existed before SCHO-206, so the guided install's releases are signed with a demo
release key (`EDUCATEOS_RELEASE_SIGNING_KEY`). Its root key set has threshold 1.

- The private halves are only in the owner's macOS Keychain, as `educateos-release-signing-key`
  and `educateos-release-root-key`.
- The public halves are pinned in `RELEASE_TRUST` (`sites/educateos-io/wrangler.jsonc`).
- Release `r000001-088ddc0` (version 0.1.0, canary, built from main `088ddc08`) is the first one
  signed with it.

Before districts depend on it, move signing to a CI-held key on the release job
(`release-signing.md`), and rotate it in with `RootReleaseSigner.rotate`.

### First live run of the installer

These were the installer's first runs against a live account (2026-10-26), using the CLI with the
same token permissions. They found one bug: `GET /accounts/{id}/workers/domains` answers
`"errors": null`, which the response envelope refused, so preflight reported the API as
unavailable. `cloudflare-http.ts` now reads `null` as no errors, with a test. With that fixed, a
CLI apply into account c07a7e70 created all 13 resources of release `r000001-088ddc0`, and both
hostnames then served behind Access.
