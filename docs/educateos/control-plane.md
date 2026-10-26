# The educateos.io control plane

- Status: skeleton (operator sign-in and the store). The installation dashboard and the guided
  install follow in later PRs of SCHO-206; billing (SCHO-208) and the marketplace (SCHO-209) build
  on this.
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
| `/app`, `/app/*` | The operator console, behind Cloudflare Access, on educateos.io only. The other hostnames redirect there, since the Access application covers only `educateos.io/app`. |

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
